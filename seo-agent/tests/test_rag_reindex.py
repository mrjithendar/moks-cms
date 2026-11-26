"""rag_reindex_flow (D-107): Settings → Integrations → Hybrid RAG → Reindex all posts, as a flow with a run log.

The web app (moks-cms src/lib/rag/callbacks.ts) plans and does each sync; the flow sends one post at a time and says
what happened to each. Stand-in: RagWeb below answers GET /rag/posts, POST /rag/posts/sync and /rag/posts/queue.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any

import pytest

from app.flows import CRON_FLOWS, MCP_KICKOFF_ALLOWLIST, SPECS, check_kickoff
from app.main import memory_container
from app.runs import RunError
from app.webapp import QUIET_PATHS, WebAppError
from tests.conftest import FakeWebApp, settings

DEST = {"url": "http://rag-api.rag.svc.cluster.local:8000", "collection": "cms_content", "serviceName": "moks-cms"}


def post(slug: str, *, action: str = "index", reason: str | None = None, title: str | None = None, characters: int = 4200, members: bool = False, collection: str = "blog") -> dict[str, Any]:
    return {
        "collection": collection,
        "slug": slug,
        "docId": f"{collection}:{slug}",
        "title": title or slug.replace("-", " ").capitalize(),
        "action": action,
        "reason": reason,
        "membersOnly": members,
        "characters": characters if action == "index" else 0,
        "publishedAt": "2026-11-20T10:00:00.000Z" if action == "index" else None,
        "updatedAt": "2026-11-21T10:00:00.000Z",
    }


POSTS = [
    post("keda-autoscaling", title="KEDA autoscaling on mk4", characters=12_345),
    post("members-guide", title="A members-only guide", characters=3000, members=True),
    post("argo-cd-basics", collection="notes", characters=2000),
    post("secret-launch-plan", action="remove", reason="draft", title="Secret launch plan"),
    post("next-week", action="remove", reason="scheduled", title="Next week's post"),
]


@dataclass
class RagWeb(FakeWebApp):
    rag_configured: bool = True
    rag_rows: list[dict[str, Any]] = field(default_factory=lambda: [dict(p) for p in POSTS])
    # doc_id → an exception to raise, or fields that replace the default answer
    rag_answers: dict[str, Any] = field(default_factory=dict)
    rag_sent: list[str] = field(default_factory=list)
    rag_queued: list[dict[str, str]] = field(default_factory=list)

    async def rag_posts(self) -> dict[str, Any]:
        if not self.rag_configured:
            return {"configured": False, "destination": None, "posts": []}
        return {"configured": True, "destination": DEST, "posts": self.rag_rows}

    async def rag_sync_post(self, collection: str, slug: str) -> dict[str, Any]:
        doc = f"{collection}:{slug}"
        self.rag_sent.append(doc)
        a = self.rag_answers.get(doc)
        if isinstance(a, Exception):
            raise a
        row = next(r for r in self.rag_rows if r["docId"] == doc)
        index = row["action"] == "index"
        out = {"docId": doc, "operation": "ingest" if index else "delete", "reason": row["reason"], "title": row["title"], "chunks": 4 if index else 0, "unchanged": False, "deleted": not index, "membersOnly": row["membersOnly"], "characters": row["characters"], "passes": 1, "ms": 31_200 if index else 80}
        out.update(a or {})
        return out

    async def rag_queue_posts(self, posts: list[dict[str, str]]) -> dict[str, Any]:
        self.rag_queued.extend(posts)
        return {"queued": len(posts)}


async def run(c: Any, inputs: dict[str, Any] | None = None) -> dict[str, Any]:
    r = await c.runner.kickoff("rag_reindex_flow", inputs or {}, triggered_by="manual")
    return await c.runner.wait(r["run_id"], 30)


async def logged_run(c: Any) -> tuple[dict[str, Any], list[str]]:
    """A run with its run history recorded (memory_container(history=True)): the run and its log's messages."""
    from app.run_history import install, uninstall

    root = logging.getLogger()
    level = root.level
    root.setLevel(logging.INFO)
    install(c.history)
    try:
        r = await run(c)
        await c.history.flush()
    finally:
        uninstall()
        root.setLevel(level)
    return r, [ln["message"] for ln in c.history.sink.logs if ln["run_id"] == str(r["run_id"])]


def test_registered_schedulable_and_started_by_a_person_or_a_schedule_only() -> None:
    assert "rag_reindex_flow" in SPECS and "rag_reindex_flow" in CRON_FLOWS and "rag_reindex_flow" not in MCP_KICKOFF_ALLOWLIST
    check_kickoff("rag_reindex_flow", "manual")
    check_kickoff("rag_reindex_flow", "cron")
    with pytest.raises(RunError):
        check_kickoff("rag_reindex_flow", "mcp")
    with pytest.raises(Exception):  # noqa: B017 - pydantic's ValidationError: no inputs at all
        SPECS["rag_reindex_flow"].input_model.model_validate({"full": True})
    assert "/rag/posts/sync" in QUIET_PATHS  # the flow writes its own line per post


async def test_off_in_the_web_app_does_nothing(llm: Any) -> None:
    web = RagWeb(rag_configured=False)
    r = await run(memory_container(settings(), llm=llm, web=web))
    assert r["status"] == "succeeded" and r["outputs"]["outcome"] == "not_configured" and web.rag_sent == []


async def test_every_post_one_at_a_time_published_first_and_counted(llm: Any) -> None:
    web = RagWeb(rag_answers={"blog:members-guide": {"unchanged": True, "ms": 300}, "blog:next-week": {"deleted": False}})
    r = await run(memory_container(settings(), llm=llm, web=web))
    assert r["status"] == "succeeded" and r["outputs"]["outcome"] == "reindexed"
    assert web.rag_sent == [p["docId"] for p in POSTS] and web.rag_queued == []
    res = r["outputs"]["result"]
    assert {k: res[k] for k in ("posts", "to_index", "to_remove", "members_only", "indexed", "unchanged", "chunks", "chunks_embedded", "removed", "not_there", "refused")} == {
        "posts": 5, "to_index": 3, "to_remove": 2, "members_only": 1, "indexed": 2, "unchanged": 1, "chunks": 12, "chunks_embedded": 8, "removed": 1, "not_there": 1, "refused": 0,
    }
    assert res["slowest_post"] == "blog:keda-autoscaling" and res["collection"] == "cms_content"


async def test_nothing_changed_is_an_unchanged_run(llm: Any) -> None:
    rows = [p for p in POSTS if p["action"] == "index"]
    web = RagWeb(rag_rows=[dict(p) for p in rows], rag_answers={p["docId"]: {"unchanged": True} for p in rows})
    r = await run(memory_container(settings(), llm=llm, web=web))
    assert r["status"] == "succeeded" and r["outputs"]["outcome"] == "unchanged"


async def test_the_run_log_says_where_what_and_how_each_post_went(llm: Any) -> None:
    """The run page's log: destination, what the posts table holds, the plan, each post before and after it is sent,
    each removal, a summary. Titles and addresses of posts readers cannot see stay out of stderr → Loki."""
    from app.logs import JsonFormatter
    from app.run_history import MemoryHistorySink, install, uninstall

    root = logging.getLogger()
    level = root.level
    root.setLevel(logging.INFO)
    web = RagWeb(rag_answers={"blog:members-guide": {"unchanged": True, "ms": 300}, "notes:argo-cd-basics": {"passes": 2}, "blog:next-week": {"deleted": False}})
    c = memory_container(settings(), llm=llm, web=web, history=True)
    stderr: list[str] = []
    capture = logging.Handler()
    capture.emit = lambda rec: stderr.append(JsonFormatter().format(rec))  # type: ignore[method-assign]
    root.addHandler(capture)
    install(c.history)
    try:
        r = await run(c)
        await c.history.flush()
    finally:
        uninstall()
        root.removeHandler(capture)
        root.setLevel(level)
    sink: MemoryHistorySink = c.history.sink

    def said(step: str) -> list[str]:
        return [ln["message"] for ln in sink.logs if ln["run_id"] == str(r["run_id"]) and ln["step"] == step and ln["level"] != "debug"]

    plan = said("plan")
    assert plan[0] == "Reading the web app's posts and where Hybrid RAG sends them (GET /rag/posts)"
    assert "Destination: rag-api at http://rag-api.rag.svc.cluster.local:8000, collection cms_content; the web app sends each post itself, as moks-cms with its own token" in plan
    assert "The posts table holds 5 posts: 3 readers can see (to index), 2 they cannot (to remove from cms_content)" in plan
    assert "To index, by collection: blog 2, notes 1; 1 members-only post: only the free preview is sent" in plan
    assert "To remove: 1 draft, 1 scheduled" in plan
    assert any(m.startswith("Plan: send 3 posts one at a time, newest first (17,345 characters in all), then remove 2.") for m in plan)
    assert plan[-1].startswith("plan succeeded: posts 5, to index 3, to remove 2, members only 1, characters 17,345")

    index = said("index")
    assert index[:2] == ["[1/3] blog:keda-autoscaling: sending “KEDA autoscaling on mk4”, 12,345 characters", "[1/3] blog:keda-autoscaling: indexed, 4 chunks embedded, 31.2 s"]
    assert "[2/3] blog:members-guide: sending “A members-only guide”, 3,000 characters (members-only: the free preview)" in index
    assert "[2/3] blog:members-guide: unchanged, rag-api already holds this version (4 chunks), 0.3 s" in index
    assert "[3/3] notes:argo-cd-basics: indexed, 4 chunks embedded, 31.2 s (sent twice: it changed while it was being sent)" in index
    assert not any(m.startswith("web app POST /rag/posts/sync") for m in index)  # the flow's own lines say it

    remove = said("remove")
    assert remove[0] == "Removing 2 posts readers cannot see from cms_content. Their addresses and titles are in each line's details here, not in the service logs"
    assert remove[1:3] == ["[1/2] a draft: removed from cms_content, 0.1 s", "[2/2] a scheduled post: was not in cms_content, nothing to remove, 0.1 s"]
    line = next(ln for ln in sink.logs if ln.get("event") == "rag_reindex_remove")
    assert {k: line["context"][k] for k in ("doc_id", "title", "reason")} == {"doc_id": "blog:secret-launch-plan", "title": "Secret launch plan", "reason": "draft"}

    finish = said("finish")
    assert finish[0].startswith("Hybrid RAG reindex done: 2 indexed (8 chunks embedded), 1 unchanged, 1 removed, 1 to remove were not there, 0 refused. cms_content holds 12 chunks of 3 posts; slowest: blog:keda-autoscaling (31.2 s); ")
    assert finish[0].endswith(" in all") and finish[1].startswith("finish succeeded: indexed 2, unchanged 1, removed 1, refused 0")
    assert said("index")[-1] == "index succeeded: indexed 2, unchanged 1, chunks embedded 8, resent 1"

    out = "\n".join(stderr)
    assert "Secret launch plan" not in out and "secret-launch-plan" not in out and "next-week" not in out
    assert "KEDA autoscaling on mk4" in out  # published: public anyway
    assert all("run_only" not in json.loads(x) for x in stderr)


async def test_rag_api_down_stops_and_hands_the_rest_to_the_background_sync(llm: Any) -> None:
    web = RagWeb(rag_answers={"blog:members-guide": WebAppError(503, "rag-api answered HTTP 504: upstream_error bge-m3 timeout", "rag_unavailable")})
    r, msgs = await logged_run(memory_container(settings(), llm=llm, web=web, history=True))
    assert r["status"] == "failed" and r["outputs"]["outcome"] == "stopped"
    assert web.rag_sent == ["blog:keda-autoscaling", "blog:members-guide"]
    assert [f"{q['collection']}:{q['slug']}" for q in web.rag_queued] == [p["docId"] for p in POSTS[1:]]
    res = r["outputs"]["result"]
    assert res["indexed"] == 1 and res["left"] == 4 and res["handed_over"] == 4
    assert "[2/3] blog:members-guide: rag-api answered HTTP 504: upstream_error bge-m3 timeout" in msgs
    assert any(m.startswith("Stopped at [2/3] blog:members-guide. Handed the 4 posts not done yet (this one included) to the web app's background sync: 4 queued.") for m in msgs)
    assert any(m.startswith("index failed: Stopped: rag-api answered HTTP 504") for m in msgs)


async def test_a_refused_token_stops_without_queueing(llm: Any) -> None:
    web = RagWeb(rag_answers={"blog:keda-autoscaling": WebAppError(422, "rag-api answered HTTP 401: invalid token", "rag_token_refused")})
    r = await run(memory_container(settings(), llm=llm, web=web))
    assert r["status"] == "failed" and r["outputs"]["outcome"] == "stopped"
    assert web.rag_sent == ["blog:keda-autoscaling"] and web.rag_queued == []


async def test_a_post_rag_api_refuses_is_skipped_and_named_at_the_end(llm: Any) -> None:
    web = RagWeb(rag_answers={"blog:members-guide": WebAppError(422, "rag-api answered HTTP 413: document too large", "rag_refused")})
    r, msgs = await logged_run(memory_container(settings(), llm=llm, web=web, history=True))
    assert web.rag_sent == [p["docId"] for p in POSTS]  # carried on
    assert r["status"] == "failed" and r["outputs"]["outcome"] == "some_refused" and r["outputs"]["result"]["refused"] == 1
    assert "rag-api refused 1 post: blog:members-guide" in (r.get("error") or "")
    assert "[2/3] blog:members-guide: rag-api refused this post: rag-api answered HTTP 413: document too large. Carrying on with the next one" in msgs


async def test_a_post_that_changed_state_meanwhile_is_counted_as_such(llm: Any) -> None:
    web = RagWeb(rag_answers={"blog:keda-autoscaling": {"operation": "delete", "reason": "archived", "chunks": 0}, "blog:secret-launch-plan": {"operation": "ingest", "chunks": 2}})
    r = await run(memory_container(settings(), llm=llm, web=web))
    res = r["outputs"]["result"]
    assert r["status"] == "succeeded" and res["removed_instead"] == 1 and res["indexed_instead"] == 1 and res["indexed"] == 2
