"""CrewAI console reports through report_flow (D-102): the site analyst, the evidence check, the PDF and the steps."""

from __future__ import annotations

import base64
import re
import zlib
from typing import Any

import pytest

from app.crews.report import (
    CREW,
    Action,
    Fix,
    Point,
    Recommendation,
    RootCause,
    SiteAnalysis,
    SiteAnalysisResult,
    check_analysis,
    data_numbers,
    evidence_ids,
    site_facts,
)
from app.llm import BudgetExceeded
from app.main import memory_container
from app.reports_site_pdf import fmt, render_site
from tests.conftest import settings
from tests.site_report_fixtures import sample_site_report
from tests.test_flows import run

RID = "11111111-1111-4111-8111-111111111111"


def good_analysis() -> SiteAnalysis:
    return SiteAnalysis(
        executive_summary="Flow runs rose to 120 from 100, but the success rate fell from 97.0% to 92.5% because optimize_article_flow failed 9 of 44 runs. LLM cost was $4.25.",
        achievements=[Point(text="LLM cost fell to $4.25.", evidence=["M2"])],
        risks=[Point(text="Search Console data is missing, so SEO performance cannot be judged.", evidence=["F2"]), Point(text="Generic risk with no evidence.", evidence=[])],
        root_causes=[
            RootCause(issue="optimize_article_flow failures", cause="The web app answered HTTP 503 during the runs.", status="confirmed", evidence=["F1", "E1"]),
            RootCause(issue="Lower success rate", cause="Most likely the same outage.", status="confirmed", evidence=["F2"]),
            RootCause(issue="Invented", cause="Cost tripled to 13 dollars.", status="probable", evidence=["M2"]),
        ],
        fixes=[Fix(issue="Failing optimize runs", severity="high", evidence=["F1"], impact="Recommendations wait.", fix="Retry the 9 failed runs after the web app is healthy.", steps=["1. Check claude-sonnet-5-5 latency on the 5xx runs", "2) Retry the failed runs"], expected_outcome="Success rate back near 97.0%.", effort="1 hour")],
        recommendations=[Recommendation(area="reliability", text="Add a retry on 503 for news_job_flow callbacks.", evidence=["E1"]), Recommendation(area="cost", text="Use a cheaper model.", evidence=["X9"])],
        action_plan=[Action(priority="low", action="Connect Search Console.", owner="Admin", evidence=["F2"]), Action(priority="critical", action="Retry the failed runs.", owner="optimize_article_flow", evidence=["F1"])],
    )


class FakeSiteCrew:
    def __init__(self, analysis: SiteAnalysis | None = None, error: Exception | None = None):
        self.analysis, self.error, self.seen = analysis, error, None

    async def analyse(self, dataset: dict[str, Any]) -> SiteAnalysisResult:
        self.seen = dataset
        if self.error:
            raise self.error
        return SiteAnalysisResult(self.analysis, "completed", None, 5000, 0.05)


def checked(a: SiteAnalysis) -> tuple[dict[str, Any], dict[str, Any]]:
    rep = sample_site_report(RID)
    ids, confirmed = evidence_ids(rep)
    return check_analysis(a, site_facts(rep) + data_numbers(rep), ids, confirmed)


def test_the_check_keeps_only_what_the_evidence_supports() -> None:
    clean, chk = checked(good_analysis())
    assert clean["executive_summary"].startswith("Flow runs rose to 120")  # every number is a fact
    assert [r["text"] for r in clean["risks"]] == ["Search Console data is missing, so SEO performance cannot be judged."]
    # The confirmed cause rests on a confirmed finding and a recorded error: kept. The second cites an unconfirmed
    # finding: shown as probable. The third has a number that is not a fact: left out.
    assert [(r["issue"], r["status"]) for r in clean["root_causes"]] == [("optimize_article_flow failures", "confirmed"), ("Lower success rate", "probable")]
    assert clean["root_causes"][1]["downgraded"] is True and chk["downgraded"] == 1
    # Names with digits (claude-sonnet-5-5, 5xx), step numbers and quoted data numbers (HTTP 503) are not figures.
    assert len(clean["fixes"]) == 1 and clean["fixes"][0]["evidence"] == ["F1"]
    assert [r["area"] for r in clean["recommendations"]] == ["reliability"]  # X9 is not an id of this report
    assert [a["priority"] for a in clean["action_plan"]] == ["critical", "low"]  # sorted by priority
    reasons = {(r["section"], r["reason"].split(":")[0]) for r in chk["removed"]}
    assert ("risks", "no evidence id from the report") in reasons and ("root_causes", "numbers not in the facts") in reasons
    assert any("X9" in r["reason"] for r in chk["removed"]) and chk["ok"] is False and chk["kept"] == 9


def test_a_summary_with_an_invented_number_is_dropped_not_the_report() -> None:
    a = good_analysis().model_copy(update={"executive_summary": "Runs rose 35% to 135."})
    clean, chk = checked(a)
    assert clean["executive_summary"] == "" and any(r["section"] == "executive_summary" for r in chk["removed"])
    assert clean["root_causes"]  # the rest stands


def test_the_analysis_schema_survives_strict_structured_output() -> None:
    from anthropic.lib._parse._transform import transform_schema

    def empty(node: Any) -> int:
        if isinstance(node, dict):
            own = node.get("type") == "object" and node.get("properties") == {} and node.get("additionalProperties") is False
            return int(own) + sum(empty(v) for v in node.values())
        return sum(empty(v) for v in node) if isinstance(node, list) else 0

    assert empty(transform_schema(SiteAnalysis)) == 0  # a free-form object would only ever come back as {}


def test_the_report_crew_has_an_analyst_task_with_a_code_owned_output() -> None:
    t = CREW.task("analyse")
    assert t.agent == "site_analyst" and t.output_editable is False and set(t.variables) == {"period", "categories"}
    assert {a.key for a in CREW.agents} == {"analyst", "site_analyst"}


async def test_a_console_report_runs_analysis_check_pdf_and_notify(llm, web) -> None:
    crew = FakeSiteCrew(good_analysis())
    c = memory_container(settings(), llm=llm, web=web, report_crew=lambda: crew)
    r = await run(c, "report_flow", {"report_id": RID}, "manual")
    assert r["status"] == "succeeded" and r["outputs"]["outcome"] == "done"
    assert crew.seen and crew.seen["id"] == RID  # the analyst got the web app's report
    stored = web.site_reports[RID]
    assert [x["issue"] for x in stored["analysis"]["root_causes"]] == ["optimize_article_flow failures", "Lower success rate"]
    assert stored["check"]["downgraded"] == 1 and stored["crew"]["status"] == "completed"
    assert stored["pdf"].startswith(b"%PDF-") and r["outputs"]["pdf"]["with_analysis"] is True
    assert web.notified == [f"site:{RID}"]
    # One run per report at a time: the lock target is the report id.
    assert c.store.rows[r["run_id"]]["target_id"] == RID


@pytest.mark.parametrize("error", [BudgetExceeded("llm_daily", "daily LLM budget reached"), RuntimeError("provider down")])
async def test_without_the_analysis_the_report_is_still_rendered_and_says_why(llm, web, error) -> None:
    c = memory_container(settings(), llm=llm, web=web, report_crew=lambda: FakeSiteCrew(error=error))
    r = await run(c, "report_flow", {"report_id": RID}, "manual")
    assert r["status"] == "succeeded"
    stored = web.site_reports[RID]
    assert stored["analysis"] == {} and stored["crew"]["status"] in ("skipped", "failed") and stored["crew"]["reason"]
    assert stored["pdf"].startswith(b"%PDF-") and web.notified == [f"site:{RID}"]


async def test_report_data_without_categories_fails_the_run(llm, web) -> None:
    web.site_reports[RID] = {"report": {"id": RID, "categories": []}}
    c = memory_container(settings(), llm=llm, web=web, report_crew=lambda: FakeSiteCrew(good_analysis()))
    r = await run(c, "report_flow", {"report_id": RID}, "manual")
    assert r["status"] == "failed" and "no report data" in (r["error"] or "")


def _pdf_text(pdf: bytes) -> str:
    """The text drawn in the PDF: its content streams inflated, the strings of the text operators joined."""
    out = []
    for m in re.finditer(rb"stream\r?\n(.*?)endstream", pdf, re.S):
        raw = m.group(1).strip()
        if raw.endswith(b"~>"):  # ReportLab: ASCII85 (ended by ~>), then Flate
            raw = base64.a85decode(raw.removeprefix(b"<~")[:-2])
        try:
            raw = zlib.decompress(raw)
        except zlib.error:
            pass
        out += [t.decode("latin-1").replace("\\(", "(").replace("\\)", ")") for t in re.findall(rb"\(((?:\\.|[^\\)])*)\)\s*Tj", raw)]
    return "\n".join(out)


def test_the_pdf_has_contents_sections_sources_and_page_numbers() -> None:
    rep = sample_site_report(RID)
    clean, chk = checked(good_analysis())
    pdf = render_site(rep, clean, chk)
    assert pdf.startswith(b"%PDF-") and pdf.count(b"/Type /Page\n") + pdf.count(b"/Type /Page ") + len(re.findall(rb"/Type /Page[^s]", pdf)) >= 3
    text = _pdf_text(pdf)
    for heading in ("Contents", "Executive summary", "What is going wrong", "Root cause analysis", "What can be fixed", "AI improvement recommendations", "Action plan", "CrewAI execution and performance", "LLM cost and budget", "Data sources", "Left out of the AI analysis"):
        assert heading in text, heading
    assert re.search(r"Page 1 of \d+", text) and "MOKS" in text and "Not available" in text


def test_untrusted_text_cannot_add_markup_to_the_pdf() -> None:
    rep = sample_site_report(RID)
    rep["title"] = 'Report <link href="javascript:alert(1)">click</link> <b>bold'
    rep["findings"][0]["title"] = "<font size=90>huge</font> & <para>"
    pdf = render_site(rep, {"executive_summary": "</para><img src='x'/> summary"}, {})
    # Rendered as text (escaped), never as markup: no link annotation, no action, and the build did not fail on the tags.
    assert pdf.startswith(b"%PDF-") and b"/URI" not in pdf and b"/JavaScript" not in pdf and b"/S /Launch" not in pdf


def test_values_are_formatted_as_the_web_app_labelled_them() -> None:
    assert fmt(0.925, "pct") == "92.5%" and fmt(4.25, "usd") == "$4.25" and fmt(0.0012, "usd") == "$0.0012"
    assert fmt(12_500, "ms") == "12.5 s" and fmt(950, "ms") == "950 ms" and fmt(1234567, "int") == "1,234,567"
    assert fmt(None, "int") == "–" and fmt("n/a", None) == "n/a" and fmt(2_097_152, "bytes") == "2.0 MB"


async def test_the_weekly_briefing_is_unchanged(llm, web) -> None:
    from tests.test_flows import FakeReportCrew

    c = memory_container(settings(), llm=llm, web=web, report_crew=lambda: FakeReportCrew("Clicks rose 14.1% to 665; impressions reached 24,310 (+6.2%)."))
    r = await run(c, "report_flow", {"period": "weekly"}, "cron")
    assert r["status"] == "succeeded" and web.reports["rep-weekly"]["narrative"].startswith("Clicks rose") and RID not in web.site_reports


def test_a_report_built_by_the_web_app_passes_the_check_and_renders() -> None:
    # tests/fixtures/site_report_cms.json is what moks-cms src/lib/reports/build.ts made for a site-wide report on a test
    # database (2026-11-24): every category, the sources' status, findings, facts and untrusted error text. If the web
    # app's shape changes, regenerate it and keep this test passing.
    import json
    import pathlib

    d = json.loads((pathlib.Path(__file__).parent / "fixtures" / "site_report_cms.json").read_text())
    assert d["schema"] == "site-report/1" and len(d["categories"]) == 15
    ids, confirmed = evidence_ids(d)
    failing = d["findings"][0]
    failed = next(f for f in d["facts"] if f["label"].endswith(": Failed"))
    a = SiteAnalysis(
        executive_summary=f"{failed['value']} runs failed. {failing['title']}.",
        root_causes=[RootCause(issue=failing["title"], cause="The web app answered HTTP 503 during those runs.", status="confirmed", evidence=failing["evidence"])],
        action_plan=[Action(priority="high", action="Retry the failed runs after the web app is healthy", owner=failing.get("owner") or "", evidence=[failing["id"]])],
    )
    clean, chk = check_analysis(a, site_facts(d) + data_numbers(d), ids, confirmed)
    assert chk["ok"] and chk["kept"] == 3 and clean["root_causes"][0]["status"] == "confirmed"
    text = _pdf_text(render_site(d, clean, chk))
    for c in d["categories"]:
        assert c["label"] in text, c["label"]
    assert re.search(r"Page 1 of (\d+)", text)
