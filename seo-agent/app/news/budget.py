"""News budgets (docs/news/COSTS.md).

**LLM spend has no cap here.** Every news LLM call goes through LiteLLM like any other call, and LiteLLM holds the
budgets (D-110): `NewsLlm` only names the purpose "news.*" and books the cost LiteLLM reported to the news run. The
LLM spend is still shown per run and per period (status()), without a cap.

**Image spend keeps its caps** (per job and global, daily and monthly). They are checked before every image
generation; when one would be crossed nothing is sent, `BudgetExceeded` is raised and the run ends as
`paused_budget` with the cap named. Days and months are calendar periods in the job's time zone (global caps: UTC).
Spend is read from news_runs (cost_usd / image_cost_usd), which every call updates as it completes.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, TypeVar
from zoneinfo import ZoneInfo

from pydantic import BaseModel

from ..llm import BudgetExceeded, CallSpec, Llm, Usage
from .config import Job, NewsSettings
from .store import NewsStore

T = TypeVar("T", bound=BaseModel)


def period_starts(now: datetime, tz: str) -> tuple[datetime, datetime]:
    try:
        z = ZoneInfo(tz)
    except Exception:
        z = ZoneInfo("UTC")
    local = now.astimezone(z)
    day = local.replace(hour=0, minute=0, second=0, microsecond=0)
    month = day.replace(day=1)
    return day.astimezone(UTC), month.astimezone(UTC)


@dataclass
class NewsBudget:
    store: NewsStore
    settings: NewsSettings
    job: Job | None
    run_id: str
    clock: Callable[[], datetime] = lambda: datetime.now(UTC)
    dry_run: bool = False

    async def status(self) -> dict[str, Any]:
        now = self.clock()
        gd, gm = period_starts(now, "UTC")
        g_day, g_month = await self.store.spend(None, gd), await self.store.spend(None, gm)
        out: dict[str, Any] = {
            "global": {"llm_day": g_day["llm"], "llm_month": g_month["llm"], "image_day": g_day["image"], "image_month": g_month["image"], "caps": {"llm_day": None, "llm_month": None, "image_day": self.settings.image_daily_usd, "image_month": self.settings.image_monthly_usd}},
        }
        if self.job:
            jd, jm = period_starts(now, self.job.timezone)
            d, m = await self.store.spend(self.job.id, jd), await self.store.spend(self.job.id, jm)
            b = self.job.config.budget
            out["job"] = {"llm_day": d["llm"], "llm_month": m["llm"], "image_day": d["image"], "image_month": m["image"], "caps": {"llm_day": None, "llm_month": None, "image_day": b.image_daily_usd, "image_month": b.image_monthly_usd}}
        return out

    async def check(self, kind: str, estimate_usd: float, *, booked: bool = False) -> None:
        """kind: image (LLM spend has no cap here: LiteLLM's budgets). Raises BudgetExceeded naming the first cap the
        estimate would cross. booked: the estimate is already included in the recorded spend (a reservation)."""
        if kind == "llm":
            return
        st = await self.status()
        checks = [("global", "day"), ("global", "month")] + ([("job", "day"), ("job", "month")] if self.job else [])
        for scope, period in checks:
            spent = st[scope][f"{kind}_{period}"] - (estimate_usd if booked else 0.0)
            cap = st[scope]["caps"][f"{kind}_{period}"]
            if spent + estimate_usd > cap:
                raise BudgetExceeded(f"news_{scope}_{kind}_{period}", f"{'this content flow' if scope == 'job' else 'the content flows'}' {'daily' if period == 'day' else 'monthly'} {kind.upper() if kind == 'llm' else 'image'} budget ${cap:.2f} would be exceeded (spent ${spent:.2f}, this call ≈ ${estimate_usd:.3f})")

    async def reserve(self, kind: str, estimate_usd: float) -> float:
        """Image spend: checks the image caps. LLM spend: nothing to check (LiteLLM refuses a call over its budgets).
        Returns the amount to `settle` (always 0)."""
        if kind != "llm":
            await self.check(kind, estimate_usd)
        return 0.0

    async def settle(self, reserved: float) -> None:
        """Kept for callers; nothing is held here any more."""
        return None

    async def ratios(self) -> dict[str, float]:
        st = await self.status()
        out = {}
        for scope in ("global", "job"):
            if scope in st:
                for k in ("llm_day", "llm_month", "image_day", "image_month"):
                    cap = st[scope]["caps"][k]
                    if cap is None:
                        continue  # LLM spend: no news cap, so no ratio
                    out[f"{scope}_{k}"] = round(st[scope][k] / cap, 4) if cap else 0.0
        return out


class NewsLlm:
    """The service's Llm for the news desk: names the purpose "news.*" and books the cost LiteLLM reported to the news
    run (and its parent). LiteLLM holds the budgets; there is no news LLM cap in front of it."""

    def __init__(self, inner: Llm, budget: NewsBudget, run_ids: list[str], *, enabled: bool = True):
        self.inner = inner
        self.budget = budget
        self.run_ids = run_ids
        self.enabled = enabled
        self.ledger = getattr(inner, "ledger", None)
        self.tokens = 0
        self.cost_usd = 0.0

    def _pre(self, spec: CallSpec) -> None:
        if not self.enabled:
            raise BudgetExceeded("news_llm_off", "LLM calls are switched off for this run (dry run without LLM)")
        if not spec.purpose.startswith("news"):
            spec.purpose = f"news.{spec.purpose}"

    async def _post(self, usage: Usage) -> None:
        c = usage.cost_usd()
        self.tokens += usage.total_tokens
        self.cost_usd += c
        for rid in self.run_ids:
            await self.budget.store.add_run_cost(rid, usd=c, tokens=usage.total_tokens)

    async def structured(self, spec: CallSpec, schema: type[T]) -> tuple[T, Usage]:
        self._pre(spec)
        out, usage = await self.inner.structured(spec, schema)
        await self._post(usage)
        return out, usage

    async def text(self, spec: CallSpec) -> tuple[str, Usage]:
        self._pre(spec)
        out, usage = await self.inner.text(spec)
        await self._post(usage)
        return out, usage

    async def stream(self, spec: CallSpec) -> AsyncIterator[str]:
        self._pre(spec)
        async for t in self.inner.stream(spec):
            yield t
