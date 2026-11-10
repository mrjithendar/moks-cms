"""Shared graph plumbing: dependencies, node instrumentation, retry policy and the review/publish tail that
optimize_article and new_article share (human_review → publish → verify_live → submit_search → schedule_measure)."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Annotated, Any

from langgraph.types import RetryPolicy, interrupt

from .. import metrics
from ..config import Settings
from ..llm import BudgetExceeded, Llm
from ..tracing import span
from ..webapp import WebApp, WebAppError


@dataclass
class Deps:
    settings: Settings
    llm: Llm
    web: WebApp
    retriever: Any
    runs: Any = None  # RunStore: current_node updates
    reindex_article: Callable[[str], Awaitable[Any]] | None = None
    start_child: Callable[[str, dict[str, Any], str], Awaitable[dict[str, Any]]] | None = None
    wait_child: Callable[[str], Awaitable[dict[str, Any]]] | None = None
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep
    crew_factory: Any = None
    verify_delays: tuple[float, ...] = (40.0, 30.0, 60.0)
    extra: dict[str, Any] = field(default_factory=dict)


def _transient(e: BaseException) -> bool:
    if isinstance(e, WebAppError):
        return e.transient
    name = type(e).__name__
    # anthropic SDK / httpx transient errors, matched by name to avoid importing optional modules here
    return name in {"APIConnectionError", "APITimeoutError", "RateLimitError", "InternalServerError", "OverloadedError", "ConnectError", "ReadTimeout", "RemoteProtocolError"}


RETRY = RetryPolicy(initial_interval=2.0, backoff_factor=2.0, max_interval=30.0, max_attempts=3, jitter=True, retry_on=_transient)


def node(graph: str, name: str, deps: Deps, fn: Callable[[Any], Awaitable[Any]]) -> Any:
    """Wrap a node: duration histogram, OTel span, current_node on the run record."""

    async def run(state: Any) -> Any:
        started = time.monotonic()
        tid = state.get("thread_id")
        if deps.runs is not None and tid and name != "human_review":
            try:
                await deps.runs.upsert(tid, current_node=name)
            except Exception:  # noqa: S110 - the run summary must never break the graph
                pass
        with span(f"graph.{graph}.{name}", {"graph": graph, "node": name}):
            try:
                return await fn(state)
            finally:
                metrics.NODE_DURATION.labels(graph=graph, node=name).observe(time.monotonic() - started)

    run.__name__ = name
    return run


def add_errors(a: list[str] | None, b: list[str] | None) -> list[str]:
    return (a or []) + (b or [])


def add_cost(a: float | None, b: float | None) -> float:
    return round((a or 0.0) + (b or 0.0), 6)


ErrorList = Annotated[list[str], add_errors]
Cost = Annotated[float, add_cost]


# --- Shared tail -----------------------------------------------------------------------------------------------------


def review_node(deps: Deps) -> Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]:
    async def human_review(state: dict[str, Any]) -> dict[str, Any]:
        # Everything before interrupt() re-runs on resume, so this node has no side effects: the draft was already
        # written by validate. The payload is what GET /runs/{id} returns to the review UI.
        decision = interrupt(
            {
                "kind": "human_review",
                "draft_id": state.get("draft_id"),
                "article_id": state.get("article_id"),
                "summary": (state.get("change_set") or {}).get("summary") or (state.get("document") or {}).get("title"),
                "changes": len(state.get("changes") or []),
                "validation_report": state.get("validation_report"),
                "cost_usd": state.get("cost_usd", 0),
            }
        )
        d = dict(decision or {})
        if d.get("decision") not in ("approve", "reject", "edit"):
            d = {"decision": "reject", "feedback": "invalid resume payload"}
        return {"review_decision": d}

    return human_review


def after_review(state: dict[str, Any]) -> str:
    d = (state.get("review_decision") or {}).get("decision")
    return {"approve": "publish", "edit": "regenerate"}.get(d or "", "close")


def close_node(deps: Deps) -> Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]:
    async def close(state: dict[str, Any]) -> dict[str, Any]:
        # The web app already marked the draft rejected (reject route) before resuming; nothing to write here.
        return {"status": "rejected"}

    return close


def publish_node(deps: Deps) -> Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]:
    async def publish(state: dict[str, Any]) -> dict[str, Any]:
        d = state.get("review_decision") or {}
        try:
            # The web app publishes only if an admin approval with this id exists for this draft, is unused, and the
            # accepted change ids match what the admin accepted. The agent cannot publish on its own.
            r = await deps.web.publish(state["draft_id"], str(d.get("approval_id") or ""), list(d.get("accepted_change_ids") or []))
        except WebAppError as e:
            if e.transient:
                raise
            return {"status": "publish_failed", "publish_result": {"ok": False, "status": e.status, "error": e.message}, "errors": [f"publish: {e.message}"]}
        return {"publish_result": {"ok": True, **r}}

    return publish


def after_publish(state: dict[str, Any]) -> str:
    return "verify_live" if (state.get("publish_result") or {}).get("ok") else "end"


def verify_node(deps: Deps) -> Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]:
    async def verify_live(state: dict[str, Any]) -> dict[str, Any]:
        last: dict[str, Any] = {}
        n = len(deps.verify_delays)
        for attempt, delay in enumerate(deps.verify_delays, start=1):
            await deps.sleep(delay)  # the other replica's content cache lives 30 s
            last = await deps.web.verify(state["draft_id"], attempt, final=attempt == n)
            if last.get("state") == "passed":
                return {"verification": last}
        # final=True made the web app send the alert with the one-click rollback link; nothing is submitted.
        return {"verification": last, "status": "verify_failed", "errors": ["verification failed; rollback offered"]}

    return verify_live


def after_verify(state: dict[str, Any]) -> str:
    return "submit_search" if (state.get("verification") or {}).get("state") == "passed" else "end"


def submit_node(deps: Deps) -> Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]:
    async def submit_search(state: dict[str, Any]) -> dict[str, Any]:
        r = await deps.web.submit(state["draft_id"])
        if deps.reindex_article and state.get("article_id"):
            try:
                await deps.reindex_article(state["article_id"])  # incremental: only changed chunks
            except Exception as e:
                return {"submission_results": r, "errors": [f"reindex: {type(e).__name__}"]}
        return {"submission_results": r}

    return submit_search


def measure_node(deps: Deps) -> Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]:
    async def schedule_measure(state: dict[str, Any]) -> dict[str, Any]:
        # The web app's daily outcomes job captures +28/+56-day metrics for every published draft (v2,
        # captureDraftOutcomes) against the baseline stored at publish; no second scheduler here.
        return {"status": "published", "measurement": {"by": "web outcomes job", "windows_days": [28, 56]}}

    return schedule_measure


def budget_paused(e: BudgetExceeded) -> dict[str, Any]:
    return {"status": "paused_budget", "errors": [f"budget: {e.detail}"]}
