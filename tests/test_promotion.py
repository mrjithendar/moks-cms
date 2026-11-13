"""promotion_flow and content_ideas_flow with the in-memory run manager and the fake web app, plus the Promotion Crew's
output handling. No API calls: fake crews for flow routing, and the real CrewAI crew with the deterministic model."""

from __future__ import annotations

import ast
import json
import pathlib
from typing import Any

from app.crews.promotion import (
    AGENTS,
    ContentIdea,
    ContentIdeas,
    ContentIdeasResult,
    IdeaEvidence,
    PromoPost,
    PromoPosts,
    PromoPostsResult,
    PromotionCrew,
    clean_ideas,
    clean_posts,
    parse_output,
)
from app.flows import CRON_FLOWS, MCP_KICKOFF_ALLOWLIST, SPECS
from app.index import MemoryRetriever
from app.llm import BudgetExceeded, FakeLlm
from app.main import memory_container
from tests.conftest import ARTICLE, FakeWebApp, settings

LINK = "https://jithendar.com/blog/ingress-tls?utm_source=reddit&utm_medium=social&utm_campaign=promotion"
CHANNELS = [
    {"channel": "linkedin", "label": "LinkedIn", "score": 70, "link": LINK.replace("reddit", "linkedin"), "guidance": "Hook first.", "maxChars": 1300, "hasTitle": False, "linkInBody": False, "threads": []},
    {"channel": "reddit", "label": "Reddit", "score": 60, "link": LINK, "guidance": "Text post.", "maxChars": 1500, "hasTitle": True, "linkInBody": True, "threads": [{"community": "kubernetes", "title": "Ingress TLS woes", "url": "https://www.reddit.com/r/kubernetes/comments/abc/x/"}]},
]
PROMO_ARTICLE = {"articleId": ARTICLE, "title": "Ingress and TLS on Kubernetes", "path": "/blog/ingress-tls", "url": "https://jithendar.com/blog/ingress-tls", "description": "TLS at the ingress.", "excerpt": "Install cert-manager and create a ClusterIssuer.", "topQueries": ["kubernetes ingress tls"], "channels": CHANNELS}
THREAD = "https://www.reddit.com/r/devops/comments/xyz/kong_vs_traefik/"
SIGNALS = {
    "channels": [{"id": "reddit", "label": "Reddit"}],
    "gsc": {"topics": [], "queries": [{"query": "kong gateway minikube", "impressions": 420, "position": 14.2}]},
    "reddit": [{"community": "devops", "title": "Kong vs Traefik at the edge?", "url": THREAD, "score": 180, "comments": 64}],
    "covered": ["Ingress and TLS on Kubernetes"],
    "planned": [],
}


def idea(title: str, *evidence: tuple[str, str]) -> dict[str, Any]:
    return {"title": title, "angle": "A first-hand migration.", "outline": ["Why", "How", "What broke"], "target_query": None, "channels": ["reddit"], "evidence": [{"type": t, "value": v} for t, v in evidence]}


class FakePromotionCrew:
    def __init__(self, posts: list[dict[str, Any]] | Exception | None = None, ideas: list[dict[str, Any]] | Exception | None = None):
        self.posts, self.idea_list = posts, ideas
        self.drafted: list[str] = []

    async def draft_posts(self, article: dict[str, Any]) -> PromoPostsResult:
        if isinstance(self.posts, Exception):
            raise self.posts
        self.drafted.append(article["articleId"])
        return PromoPostsResult(self.posts or [], "completed", None, 2400, 0.004)

    async def ideas(self, signals: dict[str, Any]) -> ContentIdeasResult:
        if isinstance(self.idea_list, Exception):
            raise self.idea_list
        return ContentIdeasResult(self.idea_list or [], "completed", None, 3100, 0.006)


async def run(c: Any, name: str, inputs: dict[str, Any], trigger: str = "manual") -> dict[str, Any]:
    r = await c.runner.kickoff(name, inputs, triggered_by=trigger)
    return await c.runner.wait(r["run_id"], 30)


def container(llm: Any, web: FakeWebApp, crew: FakePromotionCrew) -> Any:
    return memory_container(settings(), llm=llm, web=web, promotion_crew=lambda: crew)


# --- promotion_flow ------------------------------------------------------------------------------------------------


async def test_promotion_flow_drafts_and_saves_for_review(llm, web) -> None:
    web.promo_articles = [PROMO_ARTICLE]
    posts = [{"channel": "linkedin", "title": None, "body": "TLS at the ingress, the short version.", "notes": "Link in the first comment."}]
    crew = FakePromotionCrew(posts=posts)
    r = await run(container(llm, web, crew), "promotion_flow", {"article_id": ARTICLE})
    assert r["status"] == "succeeded" and r["outputs"]["outcome"] == "drafts_ready"
    assert web.promo_drafts == {ARTICLE: posts} and crew.drafted == [ARTICLE]
    assert ("promo_collect", (ARTICLE, None)) in web.calls
    assert r["outputs"]["result"] == {"articles": 1, "drafted": 1, "reddit": "not_configured"}  # works without Reddit
    assert r["cost_usd"] > 0 and r["tokens"] == 2400
    # Text for a person only: nothing was published, submitted or approved.
    assert web.published == [] and web.submitted == [] and not [x for x in web.calls if x[0] in ("publish", "save")]


async def test_promotion_flow_skips_the_model_when_nothing_scores_high_enough(llm, web) -> None:
    web.promo_articles = [{**PROMO_ARTICLE, "channels": []}]
    crew = FakePromotionCrew(posts=[{"channel": "x", "body": "unused"}])
    r = await run(container(llm, web, crew), "promotion_flow", {}, "cron")
    assert r["status"] == "succeeded" and r["outputs"]["outcome"] == "no_drafts_needed"
    assert crew.drafted == [] and web.promo_drafts == {}


async def test_promotion_flow_does_nothing_when_switched_off(llm, web) -> None:
    web.promo_enabled = False
    crew = FakePromotionCrew()
    r = await run(container(llm, web, crew), "promotion_flow", {}, "cron")
    assert r["status"] == "succeeded" and r["outputs"]["outcome"] == "disabled" and crew.drafted == []


async def test_promotion_flow_pauses_on_budget_and_keeps_earlier_drafts(llm, web) -> None:
    second = {**PROMO_ARTICLE, "articleId": "44444444-4444-4444-8444-444444444444"}
    web.promo_articles = [PROMO_ARTICLE, second]
    posts = [{"channel": "reddit", "title": "TLS at the ingress", "body": f"What worked. {LINK}", "notes": None}]

    class OnceThenBudget(FakePromotionCrew):
        async def draft_posts(self, article: dict[str, Any]) -> PromoPostsResult:
            if self.drafted:
                raise BudgetExceeded("monthly", "monthly budget reached")
            return await super().draft_posts(article)

    r = await run(container(llm, web, OnceThenBudget(posts=posts)), "promotion_flow", {}, "cron")
    assert r["status"] == "paused_budget"
    assert list(web.promo_drafts) == [ARTICLE]  # the first article's drafts were still saved


# --- content_ideas_flow --------------------------------------------------------------------------------------------


async def test_content_ideas_flow_stores_only_ideas_with_verified_evidence(llm, web) -> None:
    web.promo_signals = SIGNALS
    ideas = [
        idea("Replacing Traefik with Kong on Minikube", ("gsc_query", "kong gateway minikube"), ("reddit", THREAD)),
        idea("An idea the signals do not support", ("gsc_query", "a query nobody typed")),
    ]
    r = await run(container(llm, web, FakePromotionCrew(ideas=ideas)), "content_ideas_flow", {}, "cron")
    assert r["status"] == "succeeded" and r["outputs"]["outcome"] == "ideas_ready"
    assert [i["title"] for i in web.promo_ideas] == ["Replacing Traefik with Kong on Minikube"]
    res = r["outputs"]["result"]
    assert res["proposed"] == 2 and res["saved"] == 1 and res["skipped"][0]["reason"] == "no verified evidence"
    assert res["signals"] == {"topics": 0, "queries": 1, "threads": 1}


async def test_content_ideas_flow_needs_signals(llm, web) -> None:
    web.promo_signals = {"gsc": {"topics": [], "queries": []}, "reddit": []}
    crew = FakePromotionCrew(ideas=[idea("Never asked for", ("reddit", THREAD))])
    r = await run(container(llm, web, crew), "content_ideas_flow", {})
    assert r["outputs"]["outcome"] == "no_signals" and web.promo_ideas == []
    assert not [x for x in web.calls if x[0] == "promo_save_ideas"]


# --- registry and safety -------------------------------------------------------------------------------------------


def test_promotion_flows_are_registered_schedulable_and_not_on_mcp() -> None:
    assert {"promotion_flow", "content_ideas_flow"} <= set(SPECS) and {"promotion_flow", "content_ideas_flow"} <= CRON_FLOWS
    assert not ({"promotion_flow", "content_ideas_flow"} & MCP_KICKOFF_ALLOWLIST)
    assert SPECS["promotion_flow"].target({"article_id": ARTICLE}) == ARTICLE and SPECS["promotion_flow"].target({}) == "site"


def test_promotion_code_never_publishes_and_its_agents_have_no_tools() -> None:
    assert all(a.tools == [] for a in AGENTS)  # text only: nothing to fetch, post or write with
    root = pathlib.Path(__file__).resolve().parents[1] / "app"
    forbidden = {"publish", "verify", "submit", "save_draft", "set_draft_status"}
    for rel in ("flows/promotion.py", "crews/promotion.py"):
        tree = ast.parse((root / rel).read_text())
        called = {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
        assert not (called & forbidden), f"{rel} touches {called & forbidden}"


# --- crew output handling ------------------------------------------------------------------------------------------


def test_clean_posts_keeps_only_requested_channels_once_and_clamps() -> None:
    parsed = PromoPosts(
        posts=[
            PromoPost(channel="LinkedIn", title="ignored: no title field", body=" Hook. ", notes=""),
            PromoPost(channel="reddit", title="T" * 400, body="B" * 5000, notes="n" * 700),
            PromoPost(channel="reddit", body="a second reddit post"),
            PromoPost(channel="tiktok", body="not requested"),
            PromoPost(channel="linkedin", body=""),
        ]
    )
    out = clean_posts(parsed, CHANNELS)
    assert [p["channel"] for p in out] == ["linkedin", "reddit"]
    assert out[0] == {"channel": "linkedin", "title": None, "body": "Hook.", "notes": None}
    assert len(out[1]["title"]) == 300 and len(out[1]["body"]) == 4000 and len(out[1]["notes"]) == 600


def test_clean_ideas_drops_ideas_without_title_or_evidence_and_respects_the_limit() -> None:
    ev = [IdeaEvidence(type="gsc_query", value="kong gateway minikube")]
    parsed = ContentIdeas(
        ideas=[
            ContentIdea(title="Too short", evidence=ev),
            ContentIdea(title="No evidence at all for this one"),
            ContentIdea(title="  Replacing   Traefik with Kong on Minikube ", outline=["Why", " ", "How"], channels=["Reddit"], evidence=ev),
            ContentIdea(title="A second well-supported article idea", evidence=ev),
        ]
    )
    out = clean_ideas(parsed, 1)
    assert len(out) == 1 and out[0]["title"] == "Replacing Traefik with Kong on Minikube"
    assert out[0]["outline"] == ["Why", "How"] and out[0]["channels"] == ["reddit"] and out[0]["target_query"] is None


def test_parse_output_reads_json_from_raw_text() -> None:
    class Out:
        pydantic = None
        raw = 'Here you go:\n{"posts": [{"channel": "x", "body": "Short and true."}]}'

    assert parse_output(Out(), PromoPosts).posts[0].body == "Short and true."  # type: ignore[union-attr]
    assert parse_output(None, PromoPosts) is None

    class Bad:
        pydantic = None
        raw = "no json here"

    assert parse_output(Bad(), PromoPosts) is None


async def test_promotion_crew_writes_posts_with_the_deterministic_model(llm: FakeLlm, web: FakeWebApp) -> None:
    final = json.dumps({"posts": [{"channel": "linkedin", "title": None, "body": "TLS at the ingress, the short version.", "notes": "Link in the first comment."}, {"channel": "reddit", "title": "TLS at a Kubernetes ingress with cert-manager", "body": f"What worked for me. Full write-up: {LINK}", "notes": "Check the self-promotion rule."}, {"channel": "facebook", "body": "not requested"}]})
    llm.queue("crew", f"Thought: I now know the final answer\nFinal Answer: {final}")
    r = await PromotionCrew(settings(), llm, web, MemoryRetriever()).draft_posts(PROMO_ARTICLE)
    assert r.status == "completed" and [p["channel"] for p in r.posts] == ["linkedin", "reddit"]
    assert LINK in r.posts[1]["body"] and r.tokens > 0
    assert llm.calls[0].agent == "copywriter" and web.calls == []  # no tool call, no web app call


async def test_promotion_crew_proposes_ideas_with_the_deterministic_model(llm: FakeLlm, web: FakeWebApp) -> None:
    final = json.dumps({"ideas": [idea("Replacing Traefik with Kong on Minikube", ("gsc_query", "kong gateway minikube"), ("reddit", THREAD))]})
    llm.queue("crew", f"Thought: I now know the final answer\nFinal Answer: {final}")
    r = await PromotionCrew(settings(), llm, web, MemoryRetriever()).ideas({**SIGNALS, "max": 5})
    assert r.status == "completed" and len(r.ideas) == 1 and r.ideas[0]["evidence"][1] == {"type": "reddit", "value": THREAD}
    assert llm.calls[0].agent == "strategist"


async def test_promotion_crew_without_channels_makes_no_model_call(llm: FakeLlm, web: FakeWebApp) -> None:
    r = await PromotionCrew(settings(), llm, web, MemoryRetriever()).draft_posts({**PROMO_ARTICLE, "channels": []})
    assert r.posts == [] and llm.calls == []
