"""Ask the Blog service: kill switch, answer cache, budget, logging and gap capture around the answer pipeline.

Privacy: the question text is stored without the IP. The web app may pass a salted HMAC of the IP (rotating salt)
for abuse analysis; it is kept ASK_BLOG_RETENTION_DAYS (default 30) and pruned with the questions. Rate limiting per IP
happens in the web app's existing middleware before a request reaches this service.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from collections import OrderedDict
from collections.abc import AsyncIterator
from typing import Any, Protocol

from . import metrics
from .ask_runtime import AskOptions, AskRuntime
from .llm import BudgetExceeded
from .services.ask_pipeline import REFUSALS, normalize_question, prompt_version


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

    async def record(self, row: dict[str, Any]) -> None:
        async with self.pool.connection() as c:
            await c.execute(
                """insert into seo_ask_log (question, normalized, ip_hash, outcome, citations, cached, cost_usd, index_version, retrieval, prompt_version)
                   values (%(question)s, %(normalized)s, %(ip_hash)s, %(outcome)s, %(citations)s::jsonb, %(cached)s, %(cost_usd)s, %(index_version)s,
                     %(retrieval)s::jsonb, %(prompt_version)s)""",
                {**row, "citations": json.dumps(row.get("citations") or []), "retrieval": json.dumps(row["retrieval"]) if row.get("retrieval") is not None else None, "prompt_version": row.get("prompt_version")},
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


class AskService:
    """`enabled` is the environment's switch (ASK_BLOG_ENABLED) and `cache_ttl_s` its default; `runtime` supplies what
    an admin set in the web app (app/ask_runtime.py), read for every question. Without a runtime the service behaves
    as before that setting existed: on for everyone when the environment says so. `guard` is the budget guard whose
    Ask-the-Blog daily cap follows the admin's budget, never above the environment's value."""

    def __init__(self, graph: Any, retriever: Any, log: AskLog, enabled: bool, cache_ttl_s: int, runtime: AskRuntime | None = None, guard: Any = None):
        self.graph = graph
        self.retriever = retriever
        self.log = log
        self.enabled = enabled
        self.runtime = runtime
        self.guard = guard
        self.budget_ceiling: float | None = getattr(guard, "ask_daily_usd", None)
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
        if self.guard is not None and self.budget_ceiling is not None:
            self.guard.ask_daily_usd = self.budget_ceiling if o.daily_budget_usd is None else min(self.budget_ceiling, o.daily_budget_usd)

    @staticmethod
    def _allowed(o: AskOptions, source: str) -> bool:
        # The public MCP tool has no site sign-in, so it is off while the assistant is for signed-in readers only.
        return o.enabled and not (source == "mcp" and o.audience != "everyone")

    async def _key(self, question: str, o: AskOptions) -> str:
        # The answer style is part of the key: a cached answer is never served in a style the admin has since changed.
        return hashlib.sha256(f"{normalize_question(question)}\n{await self.retriever.version()}\n{o.answer_length}\n{o.fallback_message}".encode()).hexdigest()

    @staticmethod
    def _input(question: str, ip_hash: str | None, o: AskOptions) -> dict[str, Any]:
        return {"question": question, "ip_hash": ip_hash, "answer_length": o.answer_length, "fallback_message": o.fallback_message}

    async def _record(self, question: str, ip_hash: str | None, res: dict[str, Any], cached: bool, state: dict[str, Any] | None = None, o: AskOptions | None = None) -> None:
        version = prompt_version(o.answer_length if o else "standard")
        try:
            await self.log.record({"question": question[:500], "normalized": normalize_question(question), "ip_hash": ip_hash, "outcome": res["outcome"], "citations": res.get("citations"), "cached": cached, "cost_usd": float(res.get("cost_usd") or 0), "index_version": await self.retriever.version(), "retrieval": retrieval_log(state, res) if state else None, "prompt_version": version})
        except Exception:  # noqa: S110 - logging must not fail an answer
            pass

    async def ask(self, question: str, ip_hash: str | None = None, source: str = "site") -> dict[str, Any]:
        """`source` is "site" (the web app, which has already checked who may ask) or "mcp" (the public MCP tool)."""
        o = await self.options()
        if not self._allowed(o, source):
            metrics.ASK_REQUESTS.labels(outcome="disabled").inc()
            return {"outcome": "disabled", "answer": "", "citations": [], "related": []}
        self._apply(o)
        key = await self._key(question, o)
        hit = self.cache.get(key)
        if hit:
            metrics.ASK_REQUESTS.labels(outcome="cached").inc()
            await self._record(question, ip_hash, {**hit, "cost_usd": 0.0}, True, o=o)  # a cache hit costs nothing
            return {**hit, "cached": True}
        try:
            s = await self.graph.ainvoke(self._input(question, ip_hash, o))
        except BudgetExceeded:
            metrics.ASK_REQUESTS.labels(outcome="budget").inc()
            return {"outcome": "budget", "answer": "The assistant is resting for today. Please try again tomorrow or use search.", "citations": [], "related": []}
        res = self._result(s)
        metrics.ASK_REQUESTS.labels(outcome=res["outcome"]).inc()
        if res["outcome"] in ("answered", "fallback"):
            self.cache.put(key, res)
        await self._record(question, ip_hash, res, False, s, o)
        return res

    @staticmethod
    def _result(s: dict[str, Any]) -> dict[str, Any]:
        if s.get("refused"):
            return {"outcome": "refused", "reason": s["refused"], "answer": REFUSALS.get(s["refused"], "I can only answer questions about this blog."), "citations": [], "related": []}
        return {"outcome": s.get("outcome", "fallback"), "answer": s.get("answer", ""), "citations": s.get("citations") or [], "related": s.get("related") or [], "cost_usd": s.get("cost_usd", 0)}

    async def stream(self, question: str, ip_hash: str | None = None) -> AsyncIterator[str]:
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
        key = await self._key(question, o)
        hit = self.cache.get(key)
        if hit:
            metrics.ASK_REQUESTS.labels(outcome="cached").inc()
            await self._record(question, ip_hash, {**hit, "cost_usd": 0.0}, True, o=o)  # a cache hit costs nothing
            yield ev("final", {**hit, "cached": True})
            return
        q: asyncio.Queue[str | None] = asyncio.Queue()

        async def run() -> dict[str, Any]:
            try:
                return await self.graph.ainvoke({**self._input(question, ip_hash, o), "stream": q})
            finally:
                await q.put(None)

        task = asyncio.create_task(run())
        # The answer is finished, cached and logged by its own task: when the client disconnects, the generator is
        # closed at a `yield` but the pipeline (and its LLM spend) runs to the end and is still recorded.
        done = asyncio.create_task(self._finish(key, question, ip_hash, task, o))
        self._bg.add(done)
        done.add_done_callback(self._bg.discard)
        while True:
            tok = await q.get()
            if tok is None:
                break
            yield ev("delta", {"text": tok})
        yield ev("final", await asyncio.shield(done))

    async def _finish(self, key: str, question: str, ip_hash: str | None, task: asyncio.Task[dict[str, Any]], o: AskOptions | None = None) -> dict[str, Any]:
        try:
            s = await task
        except BudgetExceeded:
            metrics.ASK_REQUESTS.labels(outcome="budget").inc()
            return {"outcome": "budget", "answer": "The assistant is resting for today. Please try again tomorrow or use search.", "citations": [], "related": []}
        except Exception:
            metrics.ASK_REQUESTS.labels(outcome="error").inc()
            return {"outcome": "error", "answer": "Something went wrong. Please try again.", "citations": [], "related": []}
        res = self._result(s)
        metrics.ASK_REQUESTS.labels(outcome=res["outcome"]).inc()
        if res["outcome"] in ("answered", "fallback"):
            self.cache.put(key, res)
        await self._record(question, ip_hash, res, False, s, o)
        return res
