"""Report Crew: one agent writes the weekly/monthly narrative from **pre-computed** numbers.

The agent never computes or changes metrics. `facts()` turns the report payload (built by the web app's v1
`buildReport`) into a flat list of labelled, already-formatted figures; the agent is told to use only those. After
the crew, `check_numbers()` extracts every number in the narrative and requires each to equal a fact at the
precision it is written ("12%" matches 12.3 %, "12.4%" does not). Any mismatch fails the report (D-59).
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

from ..config import Settings
from ..llm import Llm
from ..tools import ToolContext, data_block
from .common import AgentDef, CrewRun, build_agents, make_crew, run_crew

PROMPT_VERSION = "seo-report-crew-v1"

AGENTS = [
    AgentDef(
        "analyst",
        "SEO report writer",
        "Explain the period's search performance in plain language using only the facts provided.",
        "You write a short weekly or monthly SEO briefing for the site owner. You never calculate, estimate or round numbers yourself: you copy figures exactly as they appear in the facts, or you leave them out.",
        [],
    )
]


def _pct(v: Any) -> str | None:
    if v is None:
        return None
    try:
        return f"{float(v) * 100:+.1f}%"
    except (TypeError, ValueError):
        return None


def _num(v: Any, digits: int = 0) -> str | None:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f"{f:,.{digits}f}"


def facts(report: dict[str, Any]) -> list[dict[str, str]]:
    """Flat, labelled, pre-formatted figures. The only numbers the narrative may contain."""
    out: list[dict[str, str]] = []

    def add(label: str, value: str | None) -> None:
        if value is not None:
            out.append({"label": label, "value": value})

    p = report.get("period") or {}
    add("period start", p.get("start"))
    add("period end", p.get("end"))
    g = ((report.get("organic") or {}).get("gsc")) or {}
    cur, prev, ch = g.get("current") or {}, g.get("previous") or {}, g.get("change") or {}
    add("clicks", _num(cur.get("clicks")))
    add("clicks previous period", _num(prev.get("clicks")))
    add("clicks change", _pct(ch.get("clicks")))
    add("impressions", _num(cur.get("impressions")))
    add("impressions previous period", _num(prev.get("impressions")))
    add("impressions change", _pct(ch.get("impressions")))
    add("CTR", _pct(cur.get("ctr")).lstrip("+") if cur.get("ctr") is not None else None)  # type: ignore[union-attr]
    add("CTR change", _pct(ch.get("ctr")))
    add("average position", _num(cur.get("position"), 1))
    add("average position previous period", _num(prev.get("position"), 1))
    ga = ((report.get("organic") or {}).get("ga4")) or {}
    add("organic sessions (GA4)", _num((ga.get("current") or {}).get("organicSessions")))
    add("organic sessions change (GA4)", _pct((ga.get("change") or {}).get("organicSessions")))
    for key, label in (("growing", "growing"), ("declining", "declining"), ("bestArticles", "top")):
        for i, a in enumerate((report.get(key) or [])[:5], start=1):
            name = a.get("title") or a.get("page")
            add(f"{label} article {i}: {name} clicks", _num(a.get("clicks")))
            if key != "bestArticles":
                add(f"{label} article {i}: {name} clicks change", _num(a.get("delta")))
    r = report.get("recommendations") or {}
    for k in ("pending", "approved", "implementedInPeriod", "proposalsAcceptedInPeriod"):
        add(f"recommendations {k}", _num(r.get(k)))
    t = report.get("technical") or {}
    if t:
        add("pages crawled", _num(t.get("pagesCrawled")))
        for i in (t.get("top") or [])[:5]:
            add(f"technical issue {i.get('check')} ({i.get('severity')})", _num(i.get("count")))
    add("new opportunities", _num(len(report.get("newOpportunities") or [])))
    add("decay alerts", _num(len(report.get("decayAlerts") or [])))
    return out


_NUM = re.compile(r"(?<![\w.])[+-−]?\d[\d,]*(?:\.\d+)?%?")


def _canon(token: str) -> tuple[Decimal, int, bool] | None:
    t = token.replace(",", "").replace("−", "-").replace("+", "")
    pct = t.endswith("%")
    t = t.rstrip("%")
    try:
        d = Decimal(t)
    except InvalidOperation:
        return None
    places = len(t.split(".")[1]) if "." in t else 0
    return d, places, pct


def check_numbers(narrative: str, fact_list: list[dict[str, str]]) -> dict[str, Any]:
    """Every number in the narrative must equal a fact at the precision it is written. Dates are matched as text."""
    allowed: list[tuple[Decimal, bool]] = []
    text_facts = " ".join(f["value"] for f in fact_list)
    for f in fact_list:
        for tok in _NUM.findall(f["value"]):
            c = _canon(tok)
            if c:
                allowed.append((c[0], c[2]))
                allowed.append((abs(c[0]), c[2]))  # "fell 12.3%" for a -12.3% change
    # ISO dates in the narrative must be period dates verbatim; strip them before number matching.
    dates = re.findall(r"\b\d{4}-\d{2}-\d{2}\b", narrative)
    bad_dates = [d for d in dates if d not in text_facts]
    body = re.sub(r"\b\d{4}-\d{2}-\d{2}\b", " ", narrative)
    mismatches: list[str] = list(bad_dates)
    checked = 0
    for tok in _NUM.findall(body):
        c = _canon(tok)
        if c is None:
            continue
        val, places, pct = c
        checked += 1
        q = Decimal(1).scaleb(-places)
        if not any(p == pct and a.quantize(q, rounding=ROUND_HALF_UP) == val for a, p in allowed):
            mismatches.append(tok)
    return {"ok": not mismatches, "checked": checked + len(dates), "mismatches": mismatches[:20]}


@dataclass
class ReportCrewResult:
    narrative: str
    status: str
    reason: str | None
    tokens: int
    cost_usd: float


class ReportCrew:
    def __init__(self, settings: Settings, llm: Llm, web: Any, retriever: Any):
        self.settings, self.llm, self.web, self.retriever = settings, llm, web, retriever

    async def run(self, report: dict[str, Any], fact_list: list[dict[str, str]]) -> ReportCrewResult:
        from crewai import Task

        ctx = ToolContext(self.web, self.retriever, self.settings.docs_allowlist)

        def build(loop: asyncio.AbstractEventLoop, run: CrewRun) -> tuple[Any, list[Any]]:
            agents = build_agents(AGENTS, self.settings, self.llm, loop, run, ctx, draft_id=None, purpose="report", prompt_version=PROMPT_VERSION, crew="report", default_model=self.settings.classify_model)
            kind = report.get("type", "weekly")
            task = Task(
                description=(
                    f"Write the {kind} SEO briefing in 120–250 words of plain prose (no headings, no tables): what changed, the likely reasons the facts support, "
                    "and the 2–3 next actions from the next-actions list. Use only figures from the facts block, copied exactly; never compute a new number, "
                    "percentage or difference. If data is incomplete (data_complete=false), say so first.\n\n"
                    f"{data_block('facts', fact_list)}\n\n{data_block('context', {'data_complete': (report.get('organic') or {}).get('dataComplete'), 'next_actions': [a.get('action') for a in (report.get('nextActions') or [])][:5], 'sources': report.get('sources')})}"
                ),
                expected_output="The briefing text only.",
                agent=agents["analyst"],
            )
            return make_crew(agents, [task], self.settings), [task]

        o = await run_crew("report", build, self.settings, ctx)
        text = str(getattr(o.output, "raw", "") or "").strip() if o.output is not None else ""
        return ReportCrewResult(text, o.status if text else "incomplete", o.reason or (None if text else "no narrative"), o.tokens, o.cost_usd)
