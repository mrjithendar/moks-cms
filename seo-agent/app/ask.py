"""Ask the Blog service: kill switch, answer cache, logging and gap capture around the answer pipeline. Its spend is
limited in LiteLLM (its own key); a refusal over that budget is answered with BUDGET.

Privacy: the question text is stored without the IP. The web app may pass a salted HMAC of the IP (rotating salt)
for abuse analysis; it is kept ASK_BLOG_RETENTION_DAYS (default 30) and pruned with the questions. Rate limiting per IP
happens in the web app's existing middleware before a request reaches this service.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
import time
from collections import OrderedDict
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Protocol

from . import metrics
from .ask_runtime import AskOptions, AskRuntime
from .llm import BudgetExceeded
from .services.ask_pipeline import FOLLOWUP_SUFFIX, REFUSALS, check_input, normalize_question, prompt_version


def retrieval_log(state: dict[str, Any], res: dict[str, Any]) -> list[dict[str, Any]]:
    """What retrieval returned, for calibrating ASK_BLOG_MIN_SCORE (scripts/rag_calibrate.py): per excerpt that passed
    the floor, its cosine, fused score, URL, whether the grader kept it and whether the answer cited it."""
    graded = {h["url"] for h in state.get("answer_hits") or []} if state.get("relevant") else set()
    cited = {c["url"] for c in res.get("citations") or []}
    return [
        {"score": round(float(h.get("score", 0)), 4), "fused": round(float(h.get("fused", 0)), 5), "url": h["url"], "graded": h["url"] in graded, "cited": h["url"] in cited}
        for h in state.get("hits") or []
    ][:12]


class AskLog(Protocol):
    async def record(self, row: dict[str, Any]) -> None: ...
    async def prune(self, days: int) -> int: ...


class PgAskLog:
    def __init__(self, pool: Any):
        self.pool = pool
        # Web-app migration 0029 adds `standalone` and the feedback columns. Checked once per process, so either side
        # can deploy first: before it, rows are written as before and no feedback token is handed out.
        self._v6: bool | None = None

    async def _has_v6(self, c: Any) -> bool:
        if self._v6 is None:
            cur = await c.execute("select count(*) as n from information_schema.columns where table_name = 'seo_ask_log' and column_name in ('standalone', 'feedback_token')")
            row = await cur.fetchone()
            self._v6 = int(row["n"] if isinstance(row, dict) else row[0]) == 2
        return self._v6

    async def record(self, row: dict[str, Any]) -> None:
        params = {**row, "citations": json.dumps(row.get("citations") or []), "retrieval": json.dumps(row["retrieval"]) if row.get("retrieval") is not None else None, "prompt_version": row.get("prompt_version")}
        async with self.pool.connection() as c:
            if await self._has_v6(c):
                await c.execute(
                    """insert into seo_ask_log (question, normalized, ip_hash, outcome, citations, cached, cost_usd, index_version, retrieval, prompt_version, standalone, feedback_token)
                       values (%(question)s, %(normalized)s, %(ip_hash)s, %(outcome)s, %(citations)s::jsonb, %(cached)s, %(cost_usd)s, %(index_version)s,
                         %(retrieval)s::jsonb, %(prompt_version)s, %(standalone)s, %(feedback_token)s)""",
                    {**params, "standalone": row.get("standalone"), "feedback_token": row.get("feedback_token")},
                )
            else:
                row.pop("feedback_token", None)  # nowhere to store it: the widget must not offer feedback
                await c.execute(
                    """insert into seo_ask_log (question, normalized, ip_hash, outcome, citations, cached, cost_usd, index_version, retrieval, prompt_version)
                       values (%(question)s, %(normalized)s, %(ip_hash)s, %(outcome)s, %(citations)s::jsonb, %(cached)s, %(cost_usd)s, %(index_version)s,
                         %(retrieval)s::jsonb, %(prompt_version)s)""",
                    params,
                )
            if row["outcome"] == "fallback":
                await c.execute(
                    """insert into seo_ask_gaps (normalized, sample_question, asked, first_seen, last_seen)
                       values (%s, %s, 1, now(), now())
                       on conflict (normalized) do update set asked = seo_ask_gaps.asked + 1, last_seen = now(),
                         status = case when seo_ask_gaps.status = 'answered' then 'open' else seo_ask_gaps.status end""",
                    (row["normalized"][:300], row["question"][:500]),
                )

    async def prune(self, days: int) -> int:
        async with self.pool.connection() as c:
            cur = await c.execute("delete from seo_ask_log where at < now() - make_interval(days => %s) returning 1", (days,))
            return len(await cur.fetchall())


class MemoryAskLog:
    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []
        self.gaps: dict[str, int] = {}

    async def record(self, row: dict[str, Any]) -> None:
        self.rows.append(row)
        if row["outcome"] == "fallback":
            self.gaps[row["normalized"]] = self.gaps.get(row["normalized"], 0) + 1

    async def prune(self, days: int) -> int:
        return 0


class TtlCache:
    def __init__(self, ttl_s: int, max_items: int = 2000):
        self.ttl, self.max = ttl_s, max_items
        self.items: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()

    def get(self, k: str) -> dict[str, Any] | None:
        v = self.items.get(k)
        if not v or self.ttl <= 0 or time.monotonic() - v[0] > self.ttl:
            self.items.pop(k, None)
            return None
        self.items.move_to_end(k)
        return v[1]

    def put(self, k: str, v: dict[str, Any]) -> None:
        self.items[k] = (time.monotonic(), v)
        self.items.move_to_end(k)
        while len(self.items) > self.max:
            self.items.popitem(last=False)


BUDGET = {"outcome": "budget", "answer": "The assistant is resting for today. Please try again tomorrow or use search.", "citations": [], "related": []}


@dataclass(frozen=True)
class Prepared:
    """One question as the pipeline will answer it."""

    raw: str  # what the reader typed (logged as `question`)
    question: str  # what is retrieved, graded and answered: `raw`, or its standalone rewrite
    context_path: str | None = None  # "/blog/<slug>" when page context applies
    condensed: bool = False
    cost_usd: float = 0.0  # the condense call, added to the logged cost


class AskService:
    """`enabled` is the environment's switch (ASK_BLOG_ENABLED) and `cache_ttl_s` its default; `runtime` supplies what
    an admin set in the web app (app/ask_runtime.py), read for every question. Without a runtime the service behaves
    as before that setting existed: on for everyone when the environment says so."""

    def __init__(self, graph: Any, retriever: Any, log: AskLog, enabled: bool, cache_ttl_s: int, runtime: AskRuntime | None = None):
        self.graph = graph
        self.retriever = retriever
        self.log = log
        self.enabled = enabled
        self.runtime = runtime
        self.default_ttl = cache_ttl_s
        self.cache = TtlCache(cache_ttl_s)
        self._bg: set[asyncio.Task[Any]] = set()  # streamed answers finishing after a client disconnect

    async def options(self) -> AskOptions:
        """The options in force now. Off when the environment switch is off, whatever is saved."""
        if not self.enabled:
            return AskOptions(enabled=False)
        if self.runtime is None:
            return AskOptions(enabled=True, audience="everyone")
        return await self.runtime.options()

    def _apply(self, o: AskOptions) -> None:
        self.cache.ttl = self.default_ttl if o.cache_ttl_s is None else o.cache_ttl_s

    @staticmethod
    def _allowed(o: AskOptions, source: str) -> bool:
        # The public MCP tool has no site sign-in, so it is off while the assistant is for signed-in readers only.
        return o.enabled and not (source == "mcp" and o.audience != "everyone")

    async def _key(self, p: Prepared, o: AskOptions) -> str:
        # The answer style is part of the key: a cached answer is never served in a style the admin has since changed.
        # So is the open article when page context is on: it changes the ranking, so it can change the answer.
        return hashlib.sha256(f"{normalize_question(p.question)}\n{await self.retriever.version()}\n{o.answer_length}\n{o.fallback_message}\n{p.context_path or ''}".encode()).hexdigest()

    @staticmethod
    def _input(p: Prepared, ip_hash: str | None, o: AskOptions) -> dict[str, Any]:
        return {"question": p.question, "ip_hash": ip_hash, "answer_length": o.answer_length, "fallback_message": o.fallback_message, "context_path": p.context_path}

    async def _prepare(self, question: str, history: list[dict[str, str]] | None, context_slug: str | None, o: AskOptions) -> Prepared:
        """What the pipeline answers: the reader's question, or, for a follow-up with follow-ups on, the standalone
        rewrite (condense_question). The raw question is checked first: one the guards refuse is never rewritten (a
        rewrite could launder it), and the pipeline refuses it. Earlier turns that fail the guards are dropped.
        BudgetExceeded propagates."""
        ctx = f"/blog/{context_slug}" if o.page_context and context_slug else None
        turns = [t for t in (history or []) if t.get("q") and check_input(t["q"]) is None][-o.follow_up_turns :] if o.follow_ups else []
        condense = getattr(self.graph, "condense", None)
        if not turns or condense is None or check_input(question) is not None:
            return Prepared(question, question, ctx)
        standalone, cost = await condense(question, turns)
        return Prepared(question, standalone, ctx, condensed=normalize_question(standalone) != normalize_question(question), cost_usd=cost)

    async def _record(self, p: Prepared, ip_hash: str | None, res: dict[str, Any], cached: bool, state: dict[str, Any] | None = None, o: AskOptions | None = None) -> str | None:
        """Log one question. Returns the feedback token stored with the row (None when feedback is off or the row has
        nowhere to keep it): an unguessable handle the widget sends back with Helpful / Not helpful."""
        version = prompt_version(o.answer_length if o else "standard") + (FOLLOWUP_SUFFIX if p.condensed else "")
        offer = bool(o and o.feedback) and res["outcome"] in ("answered", "fallback")
        row: dict[str, Any] = {
            "question": p.raw[:500],
            # The gap log and clustering use what was actually answered (the standalone form of a follow-up).
            "normalized": normalize_question(p.question),
            "standalone": p.question[:500] if p.condensed else None,
            "ip_hash": ip_hash,
            "outcome": res["outcome"],
            "citations": res.get("citations"),
            "cached": cached,
            "cost_usd": float(res.get("cost_usd") or 0) + p.cost_usd,
            "index_version": await self.retriever.version(),
            "retrieval": retrieval_log(state, res) if state else None,
            "prompt_version": version,
            "feedback_token": secrets.token_hex(16) if offer else None,
        }
        try:
            await self.log.record(row)
        except Exception:  # logging must not fail an answer
            return None
        return row.get("feedback_token")

    @staticmethod
    def _with_token(res: dict[str, Any], token: str | None) -> dict[str, Any]:
        # A copy: the cached result must never carry one reader's token to another.
        return {**res, "feedback_token": token} if token else res

    async def ask(self, question: str, ip_hash: str | None = None, source: str = "site", history: list[dict[str, str]] | None = None, context_slug: str | None = None) -> dict[str, Any]:
        """`source` is "site" (the web app, which has already checked who may ask) or "mcp" (the public MCP tool)."""
        o = await self.options()
        if not self._allowed(o, source):
            metrics.ASK_REQUESTS.labels(outcome="disabled").inc()
            return {"outcome": "disabled", "answer": "", "citations": [], "related": []}
        self._apply(o)
        try:
            p = await self._prepare(question, history, context_slug, o)
        except BudgetExceeded:
            metrics.ASK_REQUESTS.labels(outcome="budget").inc()
            return dict(BUDGET)
        key = await self._key(p, o)
        hit = self.cache.get(key)
        if hit:
            metrics.ASK_REQUESTS.labels(outcome="cached").inc()
            token = await self._record(p, ip_hash, {**hit, "cost_usd": 0.0}, True, o=o)  # a cache hit costs nothing
            return self._with_token({**hit, "cached": True}, token)
        try:
            s = await self.graph.ainvoke(self._input(p, ip_hash, o))
        except BudgetExceeded:
            metrics.ASK_REQUESTS.labels(outcome="budget").inc()
            return dict(BUDGET)
        res = self._result(s)
        metrics.ASK_REQUESTS.labels(outcome=res["outcome"]).inc()
        if res["outcome"] in ("answered", "fallback"):
            self.cache.put(key, res)
        token = await self._record(p, ip_hash, res, False, s, o)
        return self._with_token(res, token)

    @staticmethod
    def _result(s: dict[str, Any]) -> dict[str, Any]:
        if s.get("refused"):
            return {"outcome": "refused", "reason": s["refused"], "answer": REFUSALS.get(s["refused"], "I can only answer questions about this blog."), "citations": [], "related": []}
        return {"outcome": s.get("outcome", "fallback"), "answer": s.get("answer", ""), "citations": s.get("citations") or [], "related": s.get("related") or [], "cost_usd": s.get("cost_usd", 0)}

    async def stream(self, question: str, ip_hash: str | None = None, history: list[dict[str, str]] | None = None, context_slug: str | None = None) -> AsyncIterator[str]:
        """Server-sent events: `delta` events while the answer streams, then one `final` event with the guarded
        answer + citations (the widget replaces the streamed text with it)."""

        def ev(name: str, data: Any) -> str:
            return f"event: {name}\ndata: {json.dumps(data)}\n\n"

        o = await self.options()
        if not self._allowed(o, "site"):
            metrics.ASK_REQUESTS.labels(outcome="disabled").inc()
            yield ev("final", {"outcome": "disabled", "answer": "", "citations": [], "related": []})
            return
        self._apply(o)
        try:
            p = await self._prepare(question, history, context_slug, o)
        except BudgetExceeded:
            metrics.ASK_REQUESTS.labels(outcome="budget").inc()
            yield ev("final", dict(BUDGET))
            return
        key = await self._key(p, o)
        hit = self.cache.get(key)
        if hit:
            metrics.ASK_REQUESTS.labels(outcome="cached").inc()
            token = await self._record(p, ip_hash, {**hit, "cost_usd": 0.0}, True, o=o)  # a cache hit costs nothing
            yield ev("final", self._with_token({**hit, "cached": True}, token))
            return
        q: asyncio.Queue[str | None] = asyncio.Queue()

        async def run() -> dict[str, Any]:
            try:
                return await self.graph.ainvoke({**self._input(p, ip_hash, o), "stream": q})
            finally:
                await q.put(None)

        task = asyncio.create_task(run())
        # The answer is finished, cached and logged by its own task: when the client disconnects, the generator is
        # closed at a `yield` but the pipeline (and its LLM spend) runs to the end and is still recorded.
        done = asyncio.create_task(self._finish(key, p, ip_hash, task, o))
        self._bg.add(done)
        done.add_done_callback(self._bg.discard)
        while True:
            tok = await q.get()
            if tok is None:
                break
            yield ev("delta", {"text": tok})
        yield ev("final", await asyncio.shield(done))

    async def _finish(self, key: str, p: Prepared, ip_hash: str | None, task: asyncio.Task[dict[str, Any]], o: AskOptions | None = None) -> dict[str, Any]:
        try:
            s = await task
        except BudgetExceeded:
            metrics.ASK_REQUESTS.labels(outcome="budget").inc()
            return dict(BUDGET)
        except Exception:
            metrics.ASK_REQUESTS.labels(outcome="error").inc()
            return {"outcome": "error", "answer": "Something went wrong. Please try again.", "citations": [], "related": []}
        res = self._result(s)
        metrics.ASK_REQUESTS.labels(outcome=res["outcome"]).inc()
        if res["outcome"] in ("answered", "fallback"):
            self.cache.put(key, res)
        token = await self._record(p, ip_hash, res, False, s, o)
        return self._with_token(res, token)
