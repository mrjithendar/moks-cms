"""The flow catalogue (docs/seo/FLOWS.md) and who may start what.

- `SPECS`: every flow, its strict input model, and its lock target (one active run per flow + target).
- `publish_flow` is started only by a human approval (`triggered_by="approval"`, set solely by the review decision
  endpoint). The runner refuses it for every other trigger: the generic kickoff API, CronJobs, child runs of other
  flows and MCP (`check_kickoff`).
- `MCP_KICKOFF_ALLOWLIST`: what the admin MCP `kickoff_flow` tool may start. Never publish_flow.
- `CRON_FLOWS`: what a schedule may start (app/schedules.py, the CrewAI console's Schedules).
- `crew_test_flow`: the console's Test run of a crew configuration (app/flows/crew_test.py); started by an admin only.
"""

from __future__ import annotations

from typing import Any

from ..runs import FlowSpec, RunError
from ..state import (
    JobInput,
    LinkingInput,
    MlInput,
    NewArticleInput,
    NoInput,
    OptimizeInput,
    PromotionInput,
    PublishInput,
    ReindexInput,
    ReportInput,
    WeeklyInput,
)
from .crew_test import CrewTestFlow, CrewTestInput
from .custom import CustomFlow, CustomFlowInput
from .jobs import Ga4SyncFlow, GscSyncFlow, TechAuditFlow
from .maintenance import AskGapsFlow, InternalLinkingFlow, ReindexFlow
from .ml import SeoMlFlow
from .new_article import NewArticleFlow
from .news import (
    NEWS_INPUTS,
    NewsDispatchFlow,
    NewsDraftFlow,
    NewsImageFlow,
    NewsIngestFlow,
    NewsJobFlow,
    NewsPlaygroundFlow,
    NewsStyleReviewFlow,
    NewsTrainFlow,
)
from .optimize_article import OptimizeArticleFlow
from .promotion import ContentIdeasFlow, PromotionFlow
from .publish import PublishFlow
from .report import ReportFlow
from .weekly import WeeklyRecommendationsFlow


def _site(_i: dict[str, Any]) -> str:
    return "site"


def _draft(i: dict[str, Any]) -> str:
    return str(i["draft_id"])


def _draft_of(i: dict[str, Any]) -> str | None:
    return str(i["draft_id"]) if i.get("draft_id") else None


SPECS: dict[str, FlowSpec] = {
    "gsc_sync_flow": FlowSpec("gsc_sync_flow", GscSyncFlow.create, JobInput, _site),
    "ga4_sync_flow": FlowSpec("ga4_sync_flow", Ga4SyncFlow.create, JobInput, _site),
    "tech_audit_flow": FlowSpec("tech_audit_flow", TechAuditFlow.create, JobInput, _site),
    "weekly_recommendations_flow": FlowSpec("weekly_recommendations_flow", WeeklyRecommendationsFlow.create, WeeklyInput, _site),
    "optimize_article_flow": FlowSpec("optimize_article_flow", OptimizeArticleFlow.create, OptimizeInput, _draft, _draft_of),
    "internal_linking_flow": FlowSpec("internal_linking_flow", InternalLinkingFlow.create, LinkingInput, _site),
    "new_article_flow": FlowSpec("new_article_flow", NewArticleFlow.create, NewArticleInput, _draft, _draft_of),
    "publish_flow": FlowSpec("publish_flow", PublishFlow.create, PublishInput, _draft, _draft_of),
    "reindex_flow": FlowSpec("reindex_flow", ReindexFlow.create, ReindexInput, _site),
    "ask_gaps_flow": FlowSpec("ask_gaps_flow", AskGapsFlow.create, NoInput, _site),
    # One run per console report (its id) or per briefing period, at a time.
    "report_flow": FlowSpec("report_flow", ReportFlow.create, ReportInput, lambda i: str(i.get("report_id") or i.get("period", "weekly"))),
    # v5 SEO-side ML (docs/seo/ML.md): one run at a time, site-wide.
    "seo_ml_flow": FlowSpec("seo_ml_flow", SeoMlFlow.create, MlInput, _site),
    # Promotion (docs/seo/PROMOTION.md): one run per article (or one site-wide run); ideas are site-wide.
    "promotion_flow": FlowSpec("promotion_flow", PromotionFlow.create, PromotionInput, lambda i: str(i.get("article_id") or "site")),
    "content_ideas_flow": FlowSpec("content_ideas_flow", ContentIdeasFlow.create, NoInput, _site),
    # News desk (docs/news/ARCHITECTURE.md). Lock targets: one active run per job; one per job + story for drafts.
    "news_dispatch_flow": FlowSpec("news_dispatch_flow", NewsDispatchFlow.create, NEWS_INPUTS["news_dispatch_flow"], _site),
    "news_job_flow": FlowSpec("news_job_flow", NewsJobFlow.create, NEWS_INPUTS["news_job_flow"], lambda i: f"job:{i['job_id']}"),
    "news_draft_flow": FlowSpec("news_draft_flow", NewsDraftFlow.create, NEWS_INPUTS["news_draft_flow"], lambda i: f"{i['job_id']}:{i['cluster_ids'][0]}:{i.get('mode', 'single')}"),
    "news_ingest_flow": FlowSpec("news_ingest_flow", NewsIngestFlow.create, NEWS_INPUTS["news_ingest_flow"], _site),
    "news_image_flow": FlowSpec("news_image_flow", NewsImageFlow.create, NEWS_INPUTS["news_image_flow"], lambda i: str(i["article_id"])),
    "news_train_flow": FlowSpec("news_train_flow", NewsTrainFlow.create, NEWS_INPUTS["news_train_flow"], _site),
    "news_style_review_flow": FlowSpec("news_style_review_flow", NewsStyleReviewFlow.create, NEWS_INPUTS["news_style_review_flow"], _site),
    "news_playground_flow": FlowSpec("news_playground_flow", NewsPlaygroundFlow.create, NEWS_INPUTS["news_playground_flow"], lambda i: f"{i['job_id']}:{i['cluster_id']}"),
    # CrewAI console (D-98): a crew configuration's test run on an earlier run's inputs. One at a time per crew.
    "crew_test_flow": FlowSpec("crew_test_flow", CrewTestFlow.create, CrewTestInput, lambda i: f"crew:{i['crew']}"),
    # Custom flows made in the admin (crew-jobs plan PR 6): one interpreter, one active run per custom flow.
    "custom_flow": FlowSpec("custom_flow", CustomFlow.create, CustomFlowInput, lambda i: f"custom:{i['flow']}"),
}
NEWS_FLOWS = frozenset(n for n in SPECS if n.startswith("news_"))

APPROVAL_ONLY = frozenset({"publish_flow"})
DRAFTING_FLOWS = ("optimize_article_flow", "new_article_flow")
MCP_KICKOFF_ALLOWLIST = frozenset({"news_job_flow", "optimize_article_flow", "new_article_flow", "internal_linking_flow", "tech_audit_flow", "report_flow", "gsc_sync_flow", "ga4_sync_flow"})
CRON_FLOWS = frozenset({"news_dispatch_flow", "news_train_flow", "news_style_review_flow", "gsc_sync_flow", "ga4_sync_flow", "tech_audit_flow", "weekly_recommendations_flow", "internal_linking_flow", "reindex_flow", "ask_gaps_flow", "report_flow", "seo_ml_flow", "promotion_flow", "content_ideas_flow", "custom_flow"})


MANUAL_ONLY = frozenset({"crew_test_flow"})  # started by a person in the console: never by a schedule, a flow or MCP


def check_kickoff(name: str, triggered_by: str) -> None:
    if name not in SPECS:
        raise RunError(404, f"unknown flow {name}")
    if name in APPROVAL_ONLY and triggered_by != "approval":
        raise RunError(403, f"{name} starts only from a human approval in the review UI")
    if triggered_by == "approval" and name not in APPROVAL_ONLY:
        raise RunError(400, "only publish_flow is started by an approval")
    if triggered_by == "mcp" and name not in MCP_KICKOFF_ALLOWLIST:
        raise RunError(403, f"{name} cannot be started from MCP")
    if name in MANUAL_ONLY and triggered_by != "manual":
        raise RunError(403, f"{name} starts only from the CrewAI console")
    if triggered_by == "cron" and name not in CRON_FLOWS:
        raise RunError(403, f"{name} cannot be scheduled")


def catalogue() -> list[dict[str, Any]]:
    """GET /flows: every flow with its input model as JSON Schema (the console's Run with parameters form), whether a
    schedule may start it, which crews it runs (a crew's test run replays these flows' runs), and what the admin's
    catalogue shows until an admin changes it: label, description, categories and how it may be started (FLOW_INFO below)."""
    from ..crews.config import registry

    crews: dict[str, list[str]] = {}
    for c in registry().values():
        for f in c.replay:
            crews.setdefault(f, []).append(c.crew)
    return [
        {
            "name": name,
            "inputs_schema": spec.input_model.model_json_schema(),
            "approval_only": name in APPROVAL_ONLY,
            "schedulable": name in CRON_FLOWS,
            "mcp": name in MCP_KICKOFF_ALLOWLIST,
            "crews": crews.get(name, []),
            "flow_step": name not in APPROVAL_ONLY and name not in MANUAL_ONLY and name != "custom_flow",
            **{k: v for k, v in flow_info(name).items() if k in ("label", "description", "categories", "start")},
        }
        for name, spec in SPECS.items()
    ]


# --- What the admin's catalogue shows (moks-cms crewai_flows / crewai_crews, migration 0041) ------------------------
#
# What the admin shows about each flow and crew defined in code: a name, one line on what it does, the categories it is
# filed under until an admin changes them, and how a run of it may be started from the console.
#
# The admin keeps its own copy of these in its catalogue (moks-cms crewai_flows / crewai_crews, migration 0041): it adds a
# flow or crew this service reports and the catalogue does not have yet, with these values, and from then on the admin's
# values win (an admin may rename, recategorise, retag, switch off or delete any of them). Categories are organisation only:
# nothing in this service reads them to decide how a flow runs.
#
# `start` (what Run with parameters may do in the console):
# - manual: started by hand with parameters, or by a schedule;
# - review: a drafting flow; its draft is regenerated from the review queue (one open draft per article);
# - approval: started only by a human approval in the review queue;
# - schedule: started by its schedule only (Run now on the schedule);
# - internal: started by other flows (a content flow's story drafts, images, the playground).


FLOW_INFO: dict[str, dict[str, Any]] = {
    "new_article_flow": {"label": "New article", "categories": ["content"], "start": "review", "description": "The Editorial crew researches, writes, reviews and edits a new article from a calendar item; the draft waits for review."},
    "optimize_article_flow": {"label": "Optimize article", "categories": ["content", "seo"], "start": "review", "description": "The Optimization crew turns recommendations into a change set for a published article; the draft waits for review."},
    "publish_flow": {"label": "Publish", "categories": ["content"], "start": "approval", "description": "Publishes an approved draft, verifies it live, submits it to search engines and reindexes it. Starts only from an approval."},
    "weekly_recommendations_flow": {"label": "Weekly recommendations", "categories": ["seo", "content"], "start": "manual", "description": "Picks this week's articles to improve and starts an Optimize article run for each."},
    "internal_linking_flow": {"label": "Internal linking", "categories": ["seo"], "start": "manual", "description": "Plans internal links between related articles."},
    "report_flow": {"label": "Report", "categories": ["seo"], "start": "manual", "description": "The Report crew writes the weekly or monthly briefing, or analyses a report from the CrewAI console (any dates and categories), checks every number and piece of evidence, renders the PDF and emails it."},
    "tech_audit_flow": {"label": "Technical audit", "categories": ["seo", "monitoring"], "start": "manual", "description": "Crawls the site and records technical SEO issues."},
    "ask_gaps_flow": {"label": "Ask the Blog gaps", "categories": ["research"], "start": "manual", "description": "Groups questions Ask the Blog could not answer into article ideas."},
    "gsc_sync_flow": {"label": "Search Console sync", "categories": ["seo", "automation"], "start": "manual", "description": "Imports Google Search Console data."},
    "ga4_sync_flow": {"label": "GA4 sync", "categories": ["seo", "automation"], "start": "manual", "description": "Imports Google Analytics 4 data."},
    "promotion_flow": {"label": "Promotion", "categories": ["content"], "start": "manual", "description": "The Promotion crew scores where to share new articles and drafts the posts."},
    "content_ideas_flow": {"label": "Content ideas", "categories": ["content", "research"], "start": "manual", "description": "Turns community and search signals into article ideas for the calendar."},
    "custom_flow": {"label": "Step flow runner", "categories": ["automation"], "start": "internal", "description": "Runs a flow made of steps (crews, other flows, conditions, drafts). Each such flow is listed under its own name."},
    "news_dispatch_flow": {"label": "Content flows housekeeping", "categories": ["content", "automation"], "start": "schedule", "description": "Keeps the content flows' gauges current on every run and does their daily clean-up. The content flows themselves start on their own times."},
    "news_job_flow": {"label": "Content flow runner", "categories": ["content", "automation"], "start": "internal", "description": "Runs one content flow: finds stories or ideas in its sources, ranks them and drafts them for review. Each content flow is listed under its own name."},
    "news_ingest_flow": {"label": "News ingest", "categories": ["content", "automation"], "start": "manual", "description": "Fetches and stores items from the news sources."},
    "news_draft_flow": {"label": "News draft", "categories": ["content"], "start": "internal", "description": "The News desk crew writes one story or digest."},
    "news_image_flow": {"label": "News image", "categories": ["content", "ai"], "start": "internal", "description": "Generates and checks a cover image for a news draft."},
    "news_train_flow": {"label": "News model training", "categories": ["ai"], "start": "manual", "description": "Retrains the news ranking model from editor decisions."},
    "news_style_review_flow": {"label": "News style review", "categories": ["content", "ai"], "start": "manual", "description": "Reviews recent edits to keep the news writing profile current."},
    "news_playground_flow": {"label": "News playground", "categories": ["content"], "start": "internal", "description": "A trial draft from the profile playground."},
    "reindex_flow": {"label": "Reindex", "categories": ["ai", "automation"], "start": "manual", "description": "Rebuilds the article search index the agents and Ask the Blog use."},
    "seo_ml_flow": {"label": "ML models", "categories": ["ai", "seo"], "start": "manual", "description": "Retrains the SEO models (decay, query clusters, intent, priority, related articles)."},
    "crew_test_flow": {"label": "Crew test run", "categories": ["automation"], "start": "internal", "description": "Runs one crew with edited prompts on the inputs of an earlier run (Crews → Test run). Saves nothing."},
}

CREW_CATEGORIES: dict[str, list[str]] = {
    "editorial": ["content"],
    "optimization": ["content", "seo"],
    "report": ["seo"],
    "promotion": ["content"],
    "news": ["content"],
}


def flow_info(name: str) -> dict[str, Any]:
    return FLOW_INFO.get(name) or {"label": name.removesuffix("_flow").replace("_", " ").capitalize(), "categories": [], "start": "manual", "description": ""}
