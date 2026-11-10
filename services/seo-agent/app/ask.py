"""Ask the Blog service: kill switch, answer cache, budget, logging and gap capture around the ask_blog graph.

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
from .graphs.ask_blog import REFUSALS, normalize_question
from .llm import BudgetExceeded


class AskLog(Protocol):
    async def record(self, row: dict[str, Any]) -> None: ...
    async def prune(self, days: int) -> int: ...


class PgAskLog:
    def __init__(self, pool: Any):
        self.pool = pool

    async def record(self, row: dict[str, Any]) -> None:
        async with self.pool.connection() as c:
            await c.execute(
                """insert into seo_ask_log (question, normalized, ip_hash, outcome, citations, cached, cost_usd, index_version)
                   values (%(question)s, %(normalized)s, %(ip_hash)s, %(outcome)s, %(citations)s::jsonb, %(cached)s, %(cost_usd)s, %(index_version)s)""",
                {**row, "citations": json.dumps(row.get("citations") or [])},
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
        if not v or time.monotonic() - v[0] > self.ttl:
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
    def __init__(self, graph: Any, retriever: Any, log: AskLog, enabled: bool, cache_ttl_s: int):
        self.graph = graph
        self.retriever = retriever
        self.log = log
        self.enabled = enabled
        self.cache = TtlCache(cache_ttl_s)

    async def _key(self, question: str) -> str:
        return hashlib.sha256(f"{normalize_question(question)}\n{await self.retriever.version()}".encode()).hexdigest()

    async def _record(self, question: str, ip_hash: str | None, res: dict[str, Any], cached: bool) -> None:
        try:
            await self.log.record({"question": question[:500], "normalized": normalize_question(question), "ip_hash": ip_hash, "outcome": res["outcome"], "citations": res.get("citations"), "cached": cached, "cost_usd": float(res.get("cost_usd") or 0), "index_version": await self.retriever.version()})
        except Exception:  # noqa: S110 - logging must not fail an answer
            pass

    async def ask(self, question: str, ip_hash: str | None = None) -> dict[str, Any]:
        if not self.enabled:
            metrics.ASK_REQUESTS.labels(outcome="disabled").inc()
            return {"outcome": "disabled", "answer": "", "citations": [], "related": []}
        key = await self._key(question)
        hit = self.cache.get(key)
        if hit:
            metrics.ASK_REQUESTS.labels(outcome="cached").inc()
            await self._record(question, ip_hash, hit, True)
            return {**hit, "cached": True}
        try:
            s = await self.graph.ainvoke({"question": question, "ip_hash": ip_hash})
        except BudgetExceeded:
            metrics.ASK_REQUESTS.labels(outcome="budget").inc()
            return {"outcome": "budget", "answer": "The assistant is resting for today. Please try again tomorrow or use search.", "citations": [], "related": []}
        res = self._result(s)
        metrics.ASK_REQUESTS.labels(outcome=res["outcome"]).inc()
        if res["outcome"] in ("answered", "fallback"):
            self.cache.put(key, res)
        await self._record(question, ip_hash, res, False)
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

        if not self.enabled:
            metrics.ASK_REQUESTS.labels(outcome="disabled").inc()
            yield ev("final", {"outcome": "disabled", "answer": "", "citations": [], "related": []})
            return
        key = await self._key(question)
        hit = self.cache.get(key)
        if hit:
            metrics.ASK_REQUESTS.labels(outcome="cached").inc()
            await self._record(question, ip_hash, hit, True)
            yield ev("final", {**hit, "cached": True})
            return
        q: asyncio.Queue[str | None] = asyncio.Queue()

        async def run() -> dict[str, Any]:
            try:
                return await self.graph.ainvoke({"question": question, "ip_hash": ip_hash, "stream": q})
            finally:
                await q.put(None)

        task = asyncio.create_task(run())
        while True:
            tok = await q.get()
            if tok is None:
                break
            yield ev("delta", {"text": tok})
        try:
            s = await task
        except BudgetExceeded:
            metrics.ASK_REQUESTS.labels(outcome="budget").inc()
            yield ev("final", {"outcome": "budget", "answer": "The assistant is resting for today. Please try again tomorrow or use search.", "citations": [], "related": []})
            return
        except Exception:
            metrics.ASK_REQUESTS.labels(outcome="error").inc()
            yield ev("final", {"outcome": "error", "answer": "Something went wrong. Please try again.", "citations": [], "related": []})
            return
        res = self._result(s)
        metrics.ASK_REQUESTS.labels(outcome=res["outcome"]).inc()
        if res["outcome"] in ("answered", "fallback"):
            self.cache.put(key, res)
        await self._record(question, ip_hash, res, False)
        yield ev("final", res)
