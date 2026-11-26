"""Run history for the news desk: one `news_runs` row per job run, `news_run_steps` for the timeline and
`news_run_logs` for the structured log the run-detail page streams (SSE).

Log lines are also written to stdout as JSON so Alloy ships them to Loki. Loki keeps only allowlisted fields
(`event`, `operation`, `outcome`, `level`, …; docs/seo/DECISIONS.md D-19), so the stdout line carries
operation=news_<step> and outcome, and the run id lives in the database row that the UI links to.
"""

from __future__ import annotations

import logging
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from ..narrate import count as _count
from ..narrate import facts as _facts
from .store import NewsStore

log = logging.getLogger("seo_agent.news")
STEPS = ("fetch", "normalize", "dedupe", "cluster", "classify", "score", "select", "draft", "quality", "image", "save", "notify")
LEVELS = ("debug", "info", "warning", "error")
# What each step does, in its first log line (app/news/desk.py and app/flows/news.py).
STEP_WORDS = {
    "fetch": "fetching new items from the content flow's enabled sources",
    "normalize": "cleaning titles, links and dates",
    "dedupe": "dropping items already seen and grouping items about the same story",
    "cluster": "grouping items about the same story",
    "classify": "labelling each story's topics and checking how new it is",
    "score": "ranking the stories (relevance to the site, freshness, sources, the ranking model)",
    "select": "picking the stories to draft within the flow's daily and per-run limits",
    "ideas": "picking article ideas",
    "draft": "the News desk crew writes the draft from the selected sources",
    "quality": "checking the draft (sources, similarity to the sources, banned phrases, required sections)",
    "image": "making the cover image",
    "save": "saving the draft to the review queue",
    "notify": "telling the editors",
    "train_classifier": "retraining the topic classifier from editor decisions",
    "train_ranker": "retraining the story ranker from editor decisions",
    "style_review": "reviewing recent editor edits to update the writing profile",
}


class StepFailed(Exception):
    pass


@dataclass
class RunRecorder:
    store: NewsStore
    run_id: str
    counters: dict[str, int] = field(default_factory=dict)
    _seq: int = 0
    _buf: list[dict[str, Any]] = field(default_factory=list)
    _step: str | None = None

    def count(self, key: str, n: int = 1) -> None:
        self.counters[key] = self.counters.get(key, 0) + n

    def log(self, level: str, message: str, **context: Any) -> None:
        lvl = level if level in LEVELS else "info"
        self._buf.append({"run_id": self.run_id, "step": self._step, "level": lvl, "message": message[:2000], "context": context, "at": datetime.now(UTC)})
        log.log({"debug": logging.DEBUG, "info": logging.INFO, "warning": logging.WARNING, "error": logging.ERROR}[lvl], message[:300], extra={"event": "news_run_log", "operation": f"news_{self._step or 'run'}", "outcome": context.get("outcome", lvl)})

    async def flush(self) -> None:
        if self._buf:
            rows, self._buf = self._buf, []
            try:
                await self.store.add_logs(rows)
            except Exception:  # noqa: S110 - logging must never break a run
                pass

    async def save_counters(self) -> None:
        try:
            await self.store.update_run(self.run_id, counters=self.counters)
        except Exception:  # noqa: S110
            pass

    @asynccontextmanager
    async def step(self, name: str, input_count: int | None = None) -> AsyncIterator[dict[str, Any]]:
        """Records the step's timing, counts and outcome. The body sets out["output"] / out["detail"]; raising marks
        the step failed (and re-raises); out["skipped"]=True marks it skipped."""
        self._seq += 1
        self._step = name
        started = time.monotonic()
        step_id = await self.store.start_step(self.run_id, name, self._seq, input_count)
        self.log("info", f"{name}: {STEP_WORDS.get(name, 'started')}" + (f" ({_count(input_count, 'item')} in)" if input_count is not None else ""), input=input_count)
        await self.flush()
        out: dict[str, Any] = {}
        try:
            yield out
        except Exception as e:
            self.log("error", f"{name}: failed: {type(e).__name__}: {str(e)[:300]}", outcome="failed")
            await self.store.finish_step(step_id, "failed", error=f"{type(e).__name__}: {str(e)[:500]}", detail=out.get("detail"))
            await self.flush()
            await self.save_counters()
            raise
        status = "skipped" if out.get("skipped") else "succeeded"
        said = _facts(out.get("detail") or {}, skip=("why_nothing",))
        self.log(
            "info",
            f"{name}: {status} in {time.monotonic() - started:.1f}s" + (f", {_count(int(out['output']), 'item')} out" if isinstance(out.get("output"), int) else "") + (f" ({said})" if said else ""),
            output=out.get("output"),
            outcome=status,
        )
        await self.store.finish_step(step_id, status, output_count=out.get("output"), detail={**(out.get("detail") or {}), "seconds": round(time.monotonic() - started, 2)})
        await self.flush()
        await self.save_counters()
