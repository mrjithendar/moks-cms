"""The shared moks-rag service: the client (app/moks_rag.py), seo_intel ingestion (app/seo_intel.py and
seo_intel_sync_flow), internal links, the cannibalization check and grounding (app/site_context.py), new_article_flow's
ground step and the API. rag-api is a fake that behaves like moks-rag/app/src/rag_api/main.py for these calls."""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from urllib.parse import unquote

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import load_settings
from app.embeddings import HashEmbeddings
from app.main import create_app, memory_container
from app.moks_rag import SERVICE_NAME, RagClient, RagError, RagWriteRefused
from app.seo_intel import MemoryRagDocStore, SyncStopped, cluster_docs, page_docs, sync, uploaded_doc
from app.seo_ml.store import MemoryMlStore
from app.site_context import anchor_suggestions, cannibalization, grounding, internal_links, target_keyword
from tests.conftest import CALENDAR, DRAFT, settings

SITE = "https://jithendar.com"
TOKEN = "rag-test-token-0123456789"
AUTH = {"Authorization": "Bearer " + "t" * 40}


def words(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9-]+", text.lower()))


@dataclass
class FakeRag:
    """rag-api: ingest replaces a doc_id's chunks, DELETE defaults to every collection, query ranks by word overlap
    (a stand-in for RRF: the score only orders), include_answer=true would call the LLM."""

    docs: dict[str, dict[str, dict[str, Any]]] = field(default_factory=lambda: {"sre_knowledge": {}, "cms_content": {}, "seo_intel": {}})
    requests: list[httpx.Request] = field(default_factory=list)
    fail: list[Any] = field(default_factory=list)  # queued for the next requests: a status code, or an exception to raise
    llm_calls: int = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.fail:
            f = self.fail.pop(0)
            if isinstance(f, Exception):
                raise f
            return httpx.Response(f, json={"detail": "upstream failed"}, headers={"retry-after": "0"} if f == 429 else {})
        if request.headers.get("authorization") != f"Bearer {TOKEN}":
            return httpx.Response(401, json={"detail": "Invalid bearer token"})
        path, service = request.url.path, request.headers.get("x-service-name", "unknown")
        if request.method == "POST" and path == "/ingest":
            b = json.loads(request.content)
            meta = {**b.get("metadata", {}), "ingested_by": service}
            for k in ("title", "source"):
                if b.get(k):
                    meta.setdefault(k, b[k])
            chunks = [b["text"][i : i + 1500] for i in range(0, len(b["text"]), 1500)]
            self.docs[b["collection"]][b["doc_id"]] = {"chunks": chunks, "metadata": meta}
            return httpx.Response(200, json={"doc_id": b["doc_id"], "collection": b["collection"], "chunks_ingested": len(chunks), "parsed_via_docling": False, "service": service})
        if request.method == "DELETE" and path.startswith("/documents/"):
            doc_id = unquote(path.removeprefix("/documents/"))
            coll = request.url.params.get("collection", "all")
            targets = list(self.docs) if coll == "all" else [coll]
            for t in targets:
                self.docs[t].pop(doc_id, None)
            return httpx.Response(200, json={"doc_id": doc_id, "collections": targets, "deleted": True, "service": service})
        if request.method == "POST" and path == "/query":
            b = json.loads(request.content)
            if b.get("include_answer", True):
                self.llm_calls += 1
            q = words(b["query"])
            scored = []
            for doc_id, d in self.docs[b["collection"]].items():
                if any(d["metadata"].get(k) != v for k, v in (b.get("filters") or {}).items()):
                    continue
                for i, ch in enumerate(d["chunks"]):
                    s = len(q & words(f"{d['metadata'].get('title', '')} {ch}"))
                    if s:
                        scored.append((s, doc_id, i, ch, d["metadata"]))
            scored.sort(key=lambda x: (-x[0], x[1], x[2]))
            sources = [{"id": f"{d}:{i}", "doc_id": d, "score": round(1 / (60 + rank), 6), "text": ch, "metadata": {**m, "doc_id": d, "chunk_index": i}} for rank, (_, d, i, ch, m) in enumerate(scored[: b.get("top_k", 6)], 1)]
            return httpx.Response(200, json={"query": b["query"], "collection": b["collection"], "model": "claude-sonnet-5-5", "answer": "LLM" if b.get("include_answer", True) else None, "sources": sources, "service": service})
        return httpx.Response(404, json={"detail": "Not Found"})

    def article(self, doc_id: str, title: str, text: str, **meta: Any) -> None:
        self.docs["cms_content"][doc_id] = {"chunks": [text], "metadata": {"title": title, **meta}}


@pytest.fixture
def fake() -> FakeRag:
    return FakeRag()


@pytest.fixture
def sleeps() -> list[float]:
    return []


@pytest.fixture
def rag(fake: FakeRag, sleeps: list[float]) -> RagClient:
    async def sleep(s: float) -> None:
        sleeps.append(s)

    return RagClient("http://rag-api.rag.svc.cluster.local:8000", TOKEN, transport=httpx.MockTransport(fake.handler), sleep=sleep)


def site(fake: FakeRag) -> None:
    """Published articles in cms_content, as moks-cms would ingest them (plus a draft and another site's page)."""
    fake.article("post-1", "How to renew cert-manager certificates", "cert-manager renews certificates before they expire; check the Certificate status and renewal time.", url=f"{SITE}/blog/renew-cert-manager", status="published", heading="Renewal")
    fake.article("post-2", "Kubernetes ingress TLS with cert-manager", "Terminate TLS at the ingress with cert-manager issuers and certificates.", path="/blog/ingress-tls", target_keyword="kubernetes ingress tls")
    fake.article("post-3", "Autoscaling with KEDA on Kubernetes", "KEDA scales deployments on Prometheus metrics.", slug="keda-autoscaling")
    fake.article("post-4", "Draft: cert-manager certificates deep dive", "cert-manager certificates renew renewal", url=f"{SITE}/blog/draft-cert", status="draft")
    fake.article("post-5", "cert-manager certificates elsewhere", "cert-manager certificates renew", url="https://other.example.com/cert-manager")


# --- the client ----------------------------------------------------------------------------------------------------


async def test_every_request_carries_the_token_the_service_name_and_a_request_id(rag: RagClient, fake: FakeRag) -> None:
    await rag.ingest(doc_id="competitor_brief:acme", text="Acme's cert-manager guide", title="Acme", metadata={"type": "competitor_brief"})
    await rag.query_cms("cert-manager")
    await rag.delete_document("competitor_brief:acme")
    assert len(fake.requests) == 3
    for r in fake.requests:
        assert r.headers["authorization"] == f"Bearer {TOKEN}" and r.headers["x-service-name"] == SERVICE_NAME == "moks-seo-agent"
        assert re.fullmatch(r"[0-9a-f]{32}", r.headers["x-request-id"])
    assert len({r.headers["x-request-id"] for r in fake.requests}) == 3


async def test_ingest_targets_seo_intel_and_delete_never_defaults_to_all(rag: RagClient, fake: FakeRag) -> None:
    fake.docs["cms_content"]["shared-id"] = {"chunks": ["moks-cms's own"], "metadata": {}}
    r = await rag.ingest(doc_id="shared-id", text="x" * 3200, metadata={"type": "style_guide"})
    body = json.loads(fake.requests[0].content)
    assert body["collection"] == "seo_intel" and body["doc_id"] == "shared-id" and r["chunks_ingested"] == 3
    await rag.delete_document("shared-id")
    assert fake.requests[1].url.params["collection"] == "seo_intel"
    assert "shared-id" not in fake.docs["seo_intel"] and "shared-id" in fake.docs["cms_content"]  # moks-cms's copy stays


async def test_writes_outside_seo_intel_and_other_services_queries_are_refused_unsent(rag: RagClient, fake: FakeRag) -> None:
    with pytest.raises(RagWriteRefused):
        await rag.ingest(doc_id="x", text="t", collection="cms_content")
    with pytest.raises(RagWriteRefused):
        await rag.delete_document("x", collection="sre_knowledge")
    with pytest.raises(RagWriteRefused):
        await rag.query("sre_knowledge", "runbook")
    with pytest.raises(ValueError):
        await rag.ingest(doc_id="gsc_performance:/blog/x", text="t")  # DELETE could never route a "/"
    assert fake.requests == []


async def test_query_never_asks_rag_api_for_an_answer(rag: RagClient, fake: FakeRag) -> None:
    site(fake)
    hits = await rag.query_cms("renew cert-manager", top_k=500)
    body = json.loads(fake.requests[0].content)
    assert body["include_answer"] is False and body["top_k"] == 50 and fake.llm_calls == 0
    assert hits and hits[0].doc_id and hits[0].metadata.get("title")


async def test_transient_errors_are_retried_with_backoff_then_succeed(rag: RagClient, fake: FakeRag, sleeps: list[float]) -> None:
    fake.fail = [503, httpx.ConnectError("refused")]
    await rag.ingest(doc_id="style_guide:site", text="Write plainly.")
    assert len(fake.requests) == 3 and sleeps == [1.0, 2.0]
    assert len({r.headers["x-request-id"] for r in fake.requests}) == 1  # one request, three attempts
    fake.requests.clear()
    fake.fail = [429]
    await rag.query_seo("x")
    assert sleeps[-1] == 0.0  # Retry-After replaces the backoff


async def test_permanent_errors_raise_at_once_and_exhausted_retries_raise(rag: RagClient, fake: FakeRag) -> None:
    fake.fail = [422]
    with pytest.raises(RagError) as e:
        await rag.ingest(doc_id="a", text="t")
    assert e.value.status == 422 and not e.value.transient and len(fake.requests) == 1
    fake.fail = [httpx.ReadTimeout("slow")] * 3
    with pytest.raises(RagError) as e:
        await rag.query_cms("x")
    assert e.value.status == 0 and e.value.transient and len(fake.requests) == 4
    bad = RagClient("http://rag-api", "wrong-token", transport=httpx.MockTransport(fake.handler))
    with pytest.raises(RagError) as e:
        await bad.query_cms("x")
    assert e.value.status == 401


async def test_one_log_line_per_request_without_the_token_or_the_text(rag: RagClient, fake: FakeRag, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger="seo_agent.moks_rag")
    fake.fail = [502]
    await rag.ingest(doc_id="competitor_brief:acme", text="SECRET-ISH competitor text", metadata={"type": "competitor_brief"})
    done = [r for r in caplog.records if getattr(r, "event", "") == "moks_rag_request"]
    assert len(done) == 1 and [getattr(r, "event", "") for r in caplog.records].count("moks_rag_retry") == 1
    rec = done[0]
    assert (rec.op, rec.collection, rec.status, rec.attempts, rec.chunks, rec.doc_id) == ("ingest", "seo_intel", 200, 2, 1, "competitor_brief:acme")
    dumped = json.dumps([r.__dict__ for r in caplog.records], default=str)
    assert TOKEN not in dumped and "SECRET-ISH" not in dumped


def test_settings_turn_the_client_on_only_with_url_and_token() -> None:
    off = load_settings({"RAG_API_URL": "http://rag-api.rag.svc.cluster.local:8000"})
    assert not off.rag_enabled and RagClient.from_settings(off) is None
    on = load_settings({"RAG_API_URL": "http://rag-api.rag.svc.cluster.local:8000/", "RAG_BEARER_TOKEN": TOKEN, "RAG_SEO_COLLECTION": "seo_intel", "RAG_CMS_COLLECTION": "Bad Name!"})
    assert on.rag_enabled and on.rag_api_url == "http://rag-api.rag.svc.cluster.local:8000" and on.rag_cms_collection == "cms_content"
    assert on.rag_cannibalization_min_similarity is None  # nothing preset
    assert load_settings({"RAG_CANNIBALIZATION_MIN_SIMILARITY": "0.8"}).rag_cannibalization_min_similarity == 0.8
    c = RagClient.from_settings(on)
    assert c is not None and (c.seo_collection, c.cms_collection) == ("seo_intel", "cms_content")


# --- seo_intel ingestion -------------------------------------------------------------------------------------------

PERF = [
    {"page": f"{SITE}/blog/renew-cert-manager", "query": "cert-manager renew", "clicks": 12, "impressions": 400, "position": 6.0},
    {"page": f"{SITE}/blog/renew-cert-manager", "query": "renew certificate cert-manager", "clicks": 3, "impressions": 100, "position": 9.0},
    {"page": f"{SITE}/blog/ingress-tls", "query": "cert-manager renew", "clicks": 1, "impressions": 50, "position": 22.0},
    {"page": f"{SITE}/blog/ingress-tls", "query": "jane@example.com cert", "clicks": 0, "impressions": 5, "position": 40.0},
    {"page": "https://other.example.com/x", "query": "cert-manager renew", "clicks": 0, "impressions": 5, "position": 3.0},
]
CLUSTERS = [
    {"query": "cert-manager renew", "cluster_id": 1, "cluster_label": "cert-manager renew"},
    {"query": "renew certificate cert-manager", "cluster_id": 1, "cluster_label": "cert-manager renew"},
    {"query": "jane@example.com cert", "cluster_id": 2, "cluster_label": "jane@example.com cert"},
]


def test_keyword_cluster_documents_carry_numbers_and_no_personal_data() -> None:
    docs = cluster_docs(CLUSTERS, PERF, SITE)
    assert [d.doc_id for d in docs] == ["keyword_cluster:cert-manager-renew"]  # the e-mail cluster is left out
    d = docs[0]
    assert d.type == "keyword_cluster" and d.target_keyword == "cert-manager renew"
    assert "all queries together: 555 impressions, 16 clicks, CTR 2.9%, average position 8.0" in d.text
    assert "- cert-manager renew: 455 impressions, 13 clicks, CTR 2.9%, average position 7.7" in d.text  # every page, impression-weighted
    assert "ranks best with /blog/renew-cert-manager" in d.text and "jane@" not in d.text
    meta = d.metadata(datetime(2026, 11, 26, 10, tzinfo=UTC))
    assert meta["type"] == "keyword_cluster" and meta["target_keyword"] == "cert-manager renew" and meta["updated_at"] == "2026-11-26T10:00:00+00:00"


def test_gsc_performance_documents_are_per_page_of_this_site_only() -> None:
    docs = {d.doc_id: d for d in page_docs(PERF, SITE)}
    assert set(docs) == {"gsc_performance:blog-renew-cert-manager", "gsc_performance:blog-ingress-tls"}
    d = docs["gsc_performance:blog-renew-cert-manager"]
    assert d.target_keyword == "cert-manager renew" and d.extra["page"] == "/blog/renew-cert-manager" and "/" not in d.doc_id.split(":", 1)[1]
    assert "jane@" not in docs["gsc_performance:blog-ingress-tls"].text


async def test_sync_sends_new_skips_unchanged_deletes_gone_and_resends_on_full(rag: RagClient, fake: FakeRag) -> None:
    store = MemoryRagDocStore()
    docs = cluster_docs(CLUSTERS, PERF, SITE) + page_docs(PERF, SITE)
    first = await sync(rag, store, docs)
    assert (first["ingested"], first["unchanged"], first["deleted"]) == (3, 0, 0)
    assert {m["metadata"]["type"] for m in fake.docs["seo_intel"].values()} == {"keyword_cluster", "gsc_performance"}
    assert all(m["metadata"]["ingested_by"] == "moks-seo-agent" and m["metadata"]["updated_at"] for m in fake.docs["seo_intel"].values())
    again = await sync(rag, store, docs)
    assert (again["ingested"], again["unchanged"]) == (0, 3) and len(fake.requests) == 3
    await rag.ingest(doc_id="competitor_brief:acme", text="Acme", metadata={"type": "competitor_brief"})
    await store.save("seo_intel", uploaded_doc("competitor_brief", "Acme", "Acme", doc_id="acme"), 1)
    shrunk = await sync(rag, store, docs[:1])  # the pages are gone; the uploaded brief is not the sync's
    assert shrunk["deleted"] == 2 and set(fake.docs["seo_intel"]) == {"keyword_cluster:cert-manager-renew", "competitor_brief:acme"}
    full = await sync(rag, store, docs[:1], full=True)
    assert full["ingested"] == 1


async def test_sync_stops_at_a_failure_and_keeps_what_it_sent(rag: RagClient, fake: FakeRag) -> None:
    store = MemoryRagDocStore()
    docs = page_docs(PERF, SITE)
    fake.fail = [500, 500, 500]  # the first document's three attempts
    with pytest.raises(SyncStopped) as e:
        await sync(rag, store, docs)
    assert e.value.result["ingested"] == 0 and "500" in e.value.result["error"]
    r = await sync(rag, store, docs)
    assert r["ingested"] == 2


# --- internal links, cannibalization, grounding --------------------------------------------------------------------


async def test_internal_links_are_published_site_articles_with_anchors(rag: RagClient, fake: FakeRag) -> None:
    site(fake)
    links = await internal_links(rag, title="Rotate cert-manager certificates safely", headings=["Why renew certificates", "Ingress TLS checks"], site_url=SITE, exclude=["/blog/keda-autoscaling"])
    by_path = {x.path: x for x in links}
    assert set(by_path) == {"/blog/renew-cert-manager", "/blog/ingress-tls"}  # no draft, no other host, not the excluded page
    assert [x.rank for x in links] == [1, 2] and all(x.url == f"{SITE}{x.path}" for x in links)  # rag-api's order kept
    renew = by_path["/blog/renew-cert-manager"]
    assert renew.anchors[0] == "renew cert-manager certificates" and renew.matched_heading == "Why renew certificates"
    assert by_path["/blog/ingress-tls"].matched_heading == "Ingress TLS checks"
    assert renew.as_internal_link().target_path == "/blog/renew-cert-manager"
    assert json.loads(fake.requests[0].content)["top_k"] == 15  # 5 articles; one article can hold several chunks
    assert len(links) <= 5


def test_anchor_text_prefers_words_the_draft_already_uses() -> None:
    from app.seo_ml.clusters import tokens

    assert anchor_suggestions("Kubernetes ingress TLS with cert-manager", "Setup › Issuers", tokens("ingress TLS on Kubernetes")) == ["Kubernetes ingress TLS", "Issuers", "Kubernetes ingress TLS with cert-manager"]


async def test_cannibalization_flags_an_article_that_targets_the_keyword(rag: RagClient, fake: FakeRag) -> None:
    site(fake)
    r = await cannibalization(rag, keyword="cert-manager renew", topic="Rotating cert-manager certificates", site_url=SITE)
    assert r.checked and r.flagged
    (m,) = r.flagged_matches
    assert m.path == "/blog/renew-cert-manager" and m.keyword_in_title and m.similarity is None
    flag = r.as_flags()[0]
    assert flag.severity == "warning" and "renew-cert-manager" in flag.reason
    same = await cannibalization(rag, keyword="Kubernetes ingress TLS", site_url=SITE)
    assert [x.path for x in same.flagged_matches] == ["/blog/ingress-tls"] and same.flagged_matches[0].same_target_keyword
    one_word = await cannibalization(rag, keyword="cert-manager", site_url=SITE)
    assert not one_word.flagged  # every cert-manager article has the word: not a reason on its own
    clear = await cannibalization(rag, keyword="velero backups", site_url=SITE)
    assert not clear.flagged and clear.checked


async def test_cannibalization_similarity_only_when_the_owner_set_a_floor(rag: RagClient, fake: FakeRag) -> None:
    site(fake)
    emb = HashEmbeddings()
    calls: list[int] = []

    async def embed(texts: list[str]) -> list[list[float]]:
        calls.append(len(texts))
        return await emb.embed(texts)

    off = await cannibalization(rag, keyword="keda autoscaling kubernetes", site_url=SITE, embed=embed)
    assert calls == [] and all(m.similarity is None for m in off.matches)
    on = await cannibalization(rag, keyword="keda autoscaling kubernetes", site_url=SITE, embed=embed, min_similarity=0.01)
    assert calls and all(m.similarity is not None for m in on.matches) and on.flagged


async def test_grounding_reads_seo_intel_and_the_site(rag: RagClient, fake: FakeRag) -> None:
    site(fake)
    await sync(rag, MemoryRagDocStore(), cluster_docs(CLUSTERS, PERF, SITE))
    brief = {"title": "Rotating cert-manager certificates", "supportingQueries": ["cert-manager renew"], "outline": ["Why rotate", "Verify"], "gap": "Asked on site"}
    assert target_keyword(brief) == "cert-manager renew" and target_keyword({"targetKeyword": " Velero  restore "}) == "Velero restore"
    g = await grounding(rag, brief, site_url=SITE)
    assert g["seo_intel"][0]["type"] == "keyword_cluster" and "455 impressions" in g["seo_intel"][0]["excerpt"]
    assert g["site_articles"][0]["url"] == f"{SITE}/blog/renew-cert-manager"
    assert {json.loads(r.content)["collection"] for r in fake.requests if r.url.path == "/query"} == {"seo_intel", "cms_content"}


# --- flows ---------------------------------------------------------------------------------------------------------


async def run(c: Any, name: str, inputs: dict[str, Any]) -> dict[str, Any]:
    r = await c.runner.kickoff(name, inputs, triggered_by="manual")
    return await c.runner.wait(r["run_id"], 30)


async def test_seo_intel_sync_flow(llm: Any, web: Any, rag: RagClient, fake: FakeRag) -> None:
    c = memory_container(settings(), llm=llm, web=web)
    assert (await run(c, "seo_intel_sync_flow", {}))["outputs"]["outcome"] == "not_configured"
    ml = MemoryMlStore(query_pages=PERF, outputs={"seo_ml_query_clusters": CLUSTERS})
    c.deps.extra.update(rag=rag, ml_store=ml)
    r = await run(c, "seo_intel_sync_flow", {})
    assert r["status"] == "succeeded" and r["outputs"]["outcome"] == "synced" and r["outputs"]["result"]["ingested"] == 3
    assert (await run(c, "seo_intel_sync_flow", {}))["outputs"]["outcome"] == "unchanged"
    fake.fail = [503] * 3
    failed = await run(c, "seo_intel_sync_flow", {"full": True})
    assert failed["status"] == "failed"


def _editorial(seen: list[dict[str, Any]]) -> Any:
    from app.crews.editorial import CrewResult
    from app.schemas import FactCheckFlag, NewArticleDraft

    class Ed:
        async def run(self, brief: dict[str, Any], **kw: Any) -> CrewResult:
            seen.append(kw)
            d = NewArticleDraft(title="Rotate cert-manager certificates", slug_suggestion="rotate", meta_description="m" * 130, outline=["a"], body_mdx="## a\n\nb", fact_check_flags=[FactCheckFlag(claim="c", reason="r")])
            return CrewResult(d, "completed", 9000, 0.05, [], [])

    return Ed()


async def test_new_article_flow_grounds_the_crew_and_flags_cannibalization(llm: Any, web: Any, rag: RagClient, fake: FakeRag) -> None:
    site(fake)
    seen: list[dict[str, Any]] = []
    c = memory_container(settings(), llm=llm, web=web, editorial_crew=lambda: _editorial(seen))
    c.deps.extra["rag"] = rag
    r = await run(c, "new_article_flow", {"draft_id": DRAFT, "calendar_id": CALENDAR})
    assert r["outputs"]["outcome"] == "draft_ready"
    ctx = seen[0]["rag_context"]
    assert ctx["keyword"] == "cert-manager renew" and ctx["site_articles"] and ctx["internal_links"][0]["path"] == "/blog/renew-cert-manager"
    flags = web.drafts[DRAFT]["document"]["fact_check_flags"]
    assert flags[0]["claim"] == "c" and any("renew-cert-manager" in f["reason"] and f["severity"] == "warning" for f in flags[1:])
    assert fake.docs["seo_intel"]["style_guide:site"]["metadata"]["type"] == "style_guide"  # the brief's guide, kept current
    assert fake.llm_calls == 0


async def test_new_article_flow_drafts_without_rag_when_it_fails_or_is_off(llm: Any, web: Any, rag: RagClient, fake: FakeRag) -> None:
    seen: list[dict[str, Any]] = []
    c = memory_container(settings(), llm=llm, web=web, editorial_crew=lambda: _editorial(seen))
    assert (await run(c, "new_article_flow", {"draft_id": DRAFT, "calendar_id": CALENDAR}))["outputs"]["outcome"] == "draft_ready"
    assert "rag_context" not in seen[0]
    c.deps.extra["rag"] = rag
    fake.fail = [httpx.ConnectError("refused")] * 3
    r = await run(c, "new_article_flow", {"draft_id": DRAFT, "calendar_id": CALENDAR})
    assert r["status"] == "succeeded" and r["outputs"]["outcome"] == "draft_ready" and "rag_context" not in seen[1]


# --- API -----------------------------------------------------------------------------------------------------------


def test_api_seo_intel_documents_and_drafting_help(llm: Any, web: Any, rag: RagClient, fake: FakeRag) -> None:
    site(fake)
    c = memory_container(settings(), llm=llm, web=web)
    with TestClient(create_app(c)) as client:
        assert client.post("/seo-intel/documents", json={"type": "competitor_brief", "title": "Acme", "text": "t"}, headers=AUTH).status_code == 503
        assert client.get("/seo-intel/documents", headers=AUTH).json() == {"configured": False, "collection": "seo_intel", "documents": []}
        c.deps.extra["rag"] = rag
        r = client.post("/seo-intel/documents", json={"type": "competitor_brief", "title": "Acme: cert-manager guide", "text": "Acme covers renewal only.", "target_keyword": "cert-manager renew", "source": "https://acme.example/guide"}, headers=AUTH)
        assert r.status_code == 200 and r.json()["doc_id"] == "competitor_brief:acme-cert-manager-guide"
        meta = fake.docs["seo_intel"]["competitor_brief:acme-cert-manager-guide"]["metadata"]
        assert (meta["type"], meta["target_keyword"]) == ("competitor_brief", "cert-manager renew") and meta["updated_at"]
        listed = client.get("/seo-intel/documents?type=competitor_brief", headers=AUTH).json()["documents"]
        assert [d["doc_id"] for d in listed] == ["competitor_brief:acme-cert-manager-guide"]
        assert client.post("/seo-intel/documents", json={"type": "keyword_cluster", "title": "x", "text": "y"}, headers=AUTH).status_code == 422
        assert client.delete("/seo-intel/documents/competitor_brief:acme-cert-manager-guide", headers=AUTH).json()["deleted"] is True
        assert "competitor_brief:acme-cert-manager-guide" not in fake.docs["seo_intel"]
        links = client.post("/site-context/internal-links", json={"title": "Rotate cert-manager certificates", "headings": ["Renewal"]}, headers=AUTH).json()["links"]
        assert links[0]["url"] == f"{SITE}/blog/renew-cert-manager" and links[0]["anchors"]
        rep = client.post("/site-context/cannibalization", json={"keyword": "cert-manager renew"}, headers=AUTH).json()
        assert rep["flagged"] and rep["matches"][0]["path"] == "/blog/renew-cert-manager"
        fake.fail = [500] * 3
        bad = client.post("/site-context/cannibalization", json={"keyword": "cert-manager renew"}, headers=AUTH)
        assert bad.status_code == 502 and bad.json()["request_id"]
        assert client.post("/site-context/internal-links", json={"title": "x"}).status_code == 401
