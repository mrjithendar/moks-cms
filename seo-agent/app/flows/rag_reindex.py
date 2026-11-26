"""rag_reindex_flow (D-107): every post of the web app → the shared Hybrid RAG service's cms_content collection.

    plan (GET /rag/posts: where the posts go, what happens to each one and why) → index (each post readers can see,
    one at a time) → remove (every other post) → finish (the totals; the run fails when a post could not be synced)

Admin → Settings → Integrations → Hybrid RAG → Reindex all posts starts it; so can Run with parameters and a schedule.

The web app does the writing: it builds each post's document (a members-only post sends its free preview, noindex
posts are left out: moks-cms src/lib/rag/sync.ts) and sends it with its own token (POST /rag/posts/sync runs the code
of its background sync jobs). This agent's moks-rag client may not write cms_content (app/moks_rag.py) and does not
here: the flow orchestrates and says what happened.

One post at a time: an ingest is bge-m3 embedding the post on mk4's CPU (30 s to minutes for a long one). A post
rag-api already holds in this exact version comes back `unchanged` at once, so a second run embeds only what changed.

What stops the run:
- rag-api is down, slow or overloaded (rag_unavailable), or the web app does not answer: the posts not done yet, this
  one included, are handed to the web app's background sync jobs (POST /rag/posts/queue), which retry with their
  backoff; the run fails and says how many it handed over;
- rag-api refuses the token (rag_token_refused) or Hybrid RAG was switched off meanwhile (rag_off): nothing more is
  sent (every other post would fail the same way).
A post rag-api refuses on its own (rag_refused: too large, say) is logged and the run carries on; finish then fails
the run and names it.

The log: the destination (rag-api's URL, collection and service name; never the token), what the posts table holds
(how many to index, in which collections, members-only previews, how many to remove and why), the plan, a line before
each post is sent and one after it (chunks, unchanged or embedded, characters, seconds), each removal, and a summary
with the slowest post. Titles and addresses of posts readers cannot see (drafts, scheduled …) are only in the run's
own log (`run_only`, the line's details on the run page), never in a message: messages also reach stderr → Loki.
"""

from __future__ import annotations

import logging
import time
from collections import Counter
from typing import Any, ClassVar

from crewai.flow import listen, persist, start
from pydantic import PrivateAttr

from ..logs import RUN_ONLY
from ..narrate import count, seconds
from ..runs import INSTANCE_ONLY
from ..state import RagReindexState
from ..webapp import WebAppError
from .base import SeoFlow

log = logging.getLogger("seo_agent.flows.rag_reindex")

# moks-cms src/lib/rag/sync.ts notIndexedBecause → (one such post, a number of them) for the removal lines.
REASONS = {
    "draft": ("a draft", "drafts"),
    "in review": ("a post in review", "in review"),
    "scheduled": ("a scheduled post", "scheduled"),
    "archived": ("an archived post", "archived"),
    "in the bin": ("a post in the bin", "in the bin"),
    "noindex": ("a noindex post", "noindex"),
    "no longer in the database": ("a deleted post", "deleted"),
}
STOP_CODES = frozenset({"rag_token_refused", "rag_off"})  # every other post would fail the same way


def _one(reason: str | None) -> str:
    """"a draft", "a scheduled post" …"""
    return REASONS[reason][0] if reason in REASONS else f"a post ({reason or 'not public'})"


def _group(reason: str, n: int) -> str:
    """"3 drafts", "1 draft", "2 in the bin" …"""
    return f"{n:,} " + ("draft" if reason == "draft" and n == 1 else REASONS[reason][1] if reason in REASONS else reason)


class Stopped(Exception):
    """The run stopped part-way (rag-api down, the token refused, Hybrid RAG off); the log says what was done."""


@persist(INSTANCE_ONLY)
class RagReindexFlow(SeoFlow[RagReindexState]):
    FLOW: ClassVar[str] = "rag_reindex_flow"
    _posts: list[dict[str, Any]] = PrivateAttr(default_factory=list)  # plan → index/remove; not persisted (can be large)
    _collection: str = PrivateAttr(default="cms_content")
    _refused: list[str] = PrivateAttr(default_factory=list)
    _started: float = PrivateAttr(default=0.0)

    @start()
    async def plan(self) -> None:
        async with self.step("plan") as rec:
            s = self.state
            self._started = time.monotonic()
            log.info("Reading the web app's posts and where Hybrid RAG sends them (GET /rag/posts)", extra={"event": "rag_reindex_read"})
            p = await self.retry(lambda: self.deps.web.rag_posts())
            if not p.get("configured"):
                s.outcome = "not_configured"
                rec.detail["reason"] = "no RAG bearer token in the web app"
                log.info(
                    "Hybrid RAG is off in the web app (no bearer token under Settings → Integrations → Hybrid RAG): nothing to send",
                    extra={"event": "rag_reindex_not_configured"},
                )
                return
            dest = p.get("destination") or {}
            posts = [x for x in (p.get("posts") or []) if isinstance(x, dict)]
            self._posts = posts
            self._collection = str(dest.get("collection") or "cms_content")
            col = self._collection
            index = [x for x in posts if x.get("action") == "index"]
            remove = [x for x in posts if x.get("action") != "index"]
            members = sum(1 for x in index if x.get("membersOnly"))
            chars = sum(int(x.get("characters") or 0) for x in index)
            log.info(
                f"Destination: rag-api at {dest.get('url')}, collection {col}; the web app sends each post itself, as {dest.get('serviceName')} with its own token",
                extra={"event": "rag_reindex_destination", "rag_api_url": dest.get("url"), "collection": col, "service_name": dest.get("serviceName")},
            )
            log.info(
                f"The posts table holds {count(len(posts), 'post')}: {len(index):,} readers can see (to index), {len(remove):,} they cannot (to remove from {col})",
                extra={"event": "rag_reindex_posts", "posts": len(posts), "to_index": len(index), "to_remove": len(remove)},
            )
            if index:
                by_col = Counter(str(x.get("collection")) for x in index)
                log.info(
                    "To index, by collection: " + ", ".join(f"{c} {n:,}" for c, n in by_col.most_common()) + (f"; {count(members, 'members-only post')}: only the free preview is sent" if members else ""),
                    extra={"event": "rag_reindex_to_index", "by_collection": dict(by_col), "members_only": members, "characters": chars},
                )
            if remove:
                why = Counter(str(x.get("reason") or "not public") for x in remove)
                log.info(
                    "To remove: " + ", ".join(_group(r, n) for r, n in why.most_common()),
                    extra={
                        "event": "rag_reindex_to_remove",
                        "by_reason": dict(why),
                        RUN_ONLY: {"posts": [{"doc_id": x.get("docId"), "title": x.get("title"), "reason": x.get("reason")} for x in remove[:500]]},
                    },
                )
            if not posts:
                log.info("No posts: nothing to send or remove", extra={"event": "rag_reindex_plan", "send": 0, "remove": 0})
            else:
                log.info(
                    f"Plan: send {count(len(index), 'post')} one at a time, newest first ({chars:,} characters in all), then remove {len(remove):,}. "
                    "rag-api embeds only new and changed posts: one it already holds in this version comes back unchanged at once",
                    extra={"event": "rag_reindex_plan", "send": len(index), "remove": len(remove), "characters": chars},
                )
            s.result = {"posts": len(posts), "to_index": len(index), "to_remove": len(remove), "members_only": members, "characters": chars, "rag_api_url": dest.get("url"), "collection": col}
            rec.detail.update(posts=len(posts), to_index=len(index), to_remove=len(remove), members_only=members, characters=chars)

    @listen(plan)
    async def index(self) -> None:
        async with self.step("index") as rec:
            s = self.state
            if s.outcome == "not_configured":
                return
            todo = [x for x in self._posts if x.get("action") == "index"]
            later = [x for x in self._posts if x.get("action") != "index"]
            # The tally is the state's own result: a run that stops part-way still shows what it did.
            t = s.result
            # chunks: what the collection holds for the posts sent; chunks_embedded: of those, what rag-api embedded now.
            t.update(indexed=0, unchanged=0, chunks=0, chunks_embedded=0, refused=0, resent=0, removed_instead=0)
            slowest: tuple[float, str] = (0.0, "")
            for i, p in enumerate(todo, 1):
                where = f"[{i}/{len(todo)}] {p.get('docId')}"
                log.info(
                    f"{where}: sending “{p.get('title')}”, {int(p.get('characters') or 0):,} characters" + (" (members-only: the free preview)" if p.get("membersOnly") else ""),
                    extra={"event": "rag_reindex_send", "doc_id": p.get("docId"), "characters": p.get("characters"), RUN_ONLY: {"title": p.get("title"), "published_at": p.get("publishedAt"), "updated_at": p.get("updatedAt")}},
                )
                r = await self._sync(p, where, todo[i - 1 :] + later)
                if r is None:
                    t["refused"] += 1
                    continue
                secs = float(r.get("ms") or 0) / 1000
                if secs > slowest[0]:
                    slowest = (secs, str(p.get("docId")))
                fields = {"event": "rag_reindex_post", "doc_id": r.get("docId"), "operation": r.get("operation"), "chunks": r.get("chunks"), "unchanged": r.get("unchanged"), "characters": r.get("characters"), "passes": r.get("passes"), "seconds": round(secs, 1)}
                if r.get("operation") == "delete":  # unpublished since the plan was read
                    t["removed_instead"] += 1
                    log.info(f"{where}: removed instead: readers cannot see it any more ({r.get('reason')}), {seconds(secs)}", extra=fields)
                    continue
                chunks = int(r.get("chunks") or 0)
                t["chunks"] += chunks
                again = " (sent twice: it changed while it was being sent)" if int(r.get("passes") or 1) > 1 else ""
                t["resent"] += 1 if again else 0
                if r.get("unchanged"):
                    t["unchanged"] += 1
                    log.info(f"{where}: unchanged, rag-api already holds this version ({count(chunks, 'chunk')}), {seconds(secs)}{again}", extra=fields)
                else:
                    t["indexed"] += 1
                    t["chunks_embedded"] += chunks
                    log.info(f"{where}: indexed, {count(chunks, 'chunk')} embedded, {seconds(secs)}{again}", extra=fields)
                if slowest[1]:
                    t.update(slowest_post=slowest[1], slowest_s=round(slowest[0], 1))
            rec.detail.update({k: t[k] for k in ("indexed", "unchanged", "chunks_embedded", "refused", "resent", "removed_instead") if t[k] or k in ("indexed", "unchanged", "chunks_embedded")})

    @listen(index)
    async def remove(self) -> None:
        async with self.step("remove") as rec:
            s = self.state
            if s.outcome == "not_configured":
                return
            todo = [x for x in self._posts if x.get("action") != "index"]
            t = s.result
            t.update(removed=0, not_there=0, indexed_instead=0, refused_removals=0)
            if todo:
                log.info(
                    f"Removing {count(len(todo), 'post')} readers cannot see from {self._collection}. Their addresses and titles are in each line's details here, not in the service logs",
                    extra={"event": "rag_reindex_removing", "count": len(todo)},
                )
            for i, p in enumerate(todo, 1):
                where = f"[{i}/{len(todo)}] {_one(p.get('reason'))}"
                r = await self._sync(p, where, todo[i - 1 :])
                if r is None:
                    t["refused_removals"] += 1
                    continue
                secs = float(r.get("ms") or 0) / 1000
                fields = {"event": "rag_reindex_remove", "operation": r.get("operation"), "deleted": r.get("deleted"), "seconds": round(secs, 1), RUN_ONLY: {"doc_id": p.get("docId"), "title": p.get("title"), "reason": p.get("reason")}}
                if r.get("operation") == "ingest":  # published since the plan was read
                    t["indexed_instead"] += 1
                    log.info(f"{where}: indexed instead, it is published now ({count(int(r.get('chunks') or 0), 'chunk')}), {seconds(secs)}", extra=fields)
                elif r.get("deleted"):
                    t["removed"] += 1
                    log.info(f"{where}: removed from {self._collection}, {seconds(secs)}", extra=fields)
                else:
                    t["not_there"] += 1
                    log.info(f"{where}: was not in {self._collection}, nothing to remove, {seconds(secs)}", extra=fields)
            rec.detail.update({k: t[k] for k in ("removed", "not_there", "indexed_instead", "refused_removals") if t[k] or k == "removed"})

    @listen(remove)
    async def finish(self) -> None:
        async with self.step("finish") as rec:
            s = self.state
            if s.outcome == "not_configured":
                return
            r = s.result

            def g(k: str) -> int:
                return int(r.get(k) or 0)

            refused = g("refused") + g("refused_removals")
            parts = [f"{g('indexed'):,} indexed ({count(g('chunks_embedded'), 'chunk')} embedded)", f"{g('unchanged'):,} unchanged", f"{g('removed'):,} removed"]
            if g("not_there"):
                parts.append(f"{g('not_there'):,} to remove were not there")
            if g("removed_instead") or g("indexed_instead"):
                parts.append(f"{g('removed_instead') + g('indexed_instead'):,} changed state while the run went")
            parts.append(f"{refused:,} refused")
            summary = "Hybrid RAG reindex done: " + ", ".join(parts)
            summary += f". {self._collection} holds {count(g('chunks'), 'chunk')} of {count(g('indexed') + g('unchanged'), 'post')}"
            if r.get("slowest_post"):
                summary += f"; slowest: {r['slowest_post']} ({seconds(float(r.get('slowest_s') or 0))})"
            took = time.monotonic() - self._started if self._started else 0.0
            summary += f"; {seconds(took)} in all"
            log.info(summary, extra={"event": "rag_reindex_done", **{k: v for k, v in r.items() if isinstance(v, int)}, "seconds": round(took, 1)})
            rec.detail.update(indexed=g("indexed"), unchanged=g("unchanged"), removed=g("removed"), refused=refused)
            if refused:
                s.outcome = "some_refused"
                named = ", ".join(self._refused[:10]) + (" …" if len(self._refused) > 10 else "")
                raise RuntimeError(f"rag-api refused {count(refused, 'post')}" + (f": {named}" if named else "") + ". Each one's reason is in its line above")
            s.outcome = "reindexed" if g("indexed") or g("removed") or g("removed_instead") or g("indexed_instead") else "unchanged"

    async def _sync(self, p: dict[str, Any], where: str, left: list[dict[str, Any]]) -> dict[str, Any] | None:
        """One post, synced by the web app. None when rag-api refused this post alone (logged; the run carries on).
        Raises Stopped when the rest cannot be sent now: rag-api or the web app down (the rest is handed to the
        background sync jobs), the token refused or Hybrid RAG switched off."""
        public = p.get("action") == "index"
        try:
            return await self.deps.web.rag_sync_post(str(p.get("collection")), str(p.get("slug")))
        except WebAppError as e:
            said = f"{e.message}" if e.message else f"HTTP {e.status or 'no answer'}"
            extra: dict[str, Any] = {"event": "rag_reindex_failed", "code": e.code, "status": e.status, **({} if public else {RUN_ONLY: {"doc_id": p.get("docId"), "title": p.get("title")}})}
            if e.code == "rag_refused":
                if public:
                    self._refused.append(str(p.get("docId")))
                log.warning(f"{where}: rag-api refused this post: {said}. Carrying on with the next one", extra=extra)
                return None
            self.state.outcome = "stopped"
            if e.code in STOP_CODES:
                log.warning(f"{where}: {said}. Stopping here: every other post would fail the same way, so nothing more is sent", extra=extra)
                raise Stopped(f"{said} (at {where})") from e
            log.warning(f"{where}: {said}", extra=extra)
            await self._hand_over(left, where)
            raise Stopped(f"{said} (at {where}); the {count(len(left), 'post')} not done yet went to the web app's background sync") from e

    async def _hand_over(self, left: list[dict[str, Any]], where: str) -> None:
        """rag-api (or the web app) is not answering: the web app's background sync jobs take the posts not done yet."""
        refs = [{"collection": str(x.get("collection")), "slug": str(x.get("slug"))} for x in left]
        try:
            q = await self.deps.web.rag_queue_posts(refs)
        except WebAppError as e:
            log.warning(
                f"Stopped at {where}. The {count(len(refs), 'post')} not done yet could not be handed to the background sync either ({e.status or 'no answer'} {e.message}): run Reindex all posts again later",
                extra={"event": "rag_reindex_stopped", "left": len(refs), "queued": 0},
            )
            self.state.result.update(left=len(refs), handed_over=0)
            return
        n = int(q.get("queued") or 0)
        log.warning(
            f"Stopped at {where}. Handed the {count(len(refs), 'post')} not done yet (this one included) to the web app's background sync: "
            f"{n:,} queued{f', {len(refs) - n:,} already waiting' if n < len(refs) else ''}. It retries them with its backoff (1, 2, 4 … 60 minutes); Settings → Integrations → Hybrid RAG shows how it goes",
            extra={"event": "rag_reindex_stopped", "left": len(refs), "queued": n},
        )
        self.state.result.update(left=len(refs), handed_over=n)
