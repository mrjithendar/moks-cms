"""Changing the embeddings model (bge-small ONNX → bge-m3 on Ollama): the provider, the per-model cutoffs
(app/calibration.py) and the news desk's stored vectors of the previous model."""

from __future__ import annotations

import json
from datetime import timedelta
from typing import Any

import httpx
import numpy as np
import pytest

from app import calibration as cal
from app.config import load_settings
from app.embeddings import OllamaEmbeddings
from app.news import classifier as clf
from app.news import desk as nd
from app.news.config import NewsSettings, Quality
from app.news.runlog import RunRecorder
from app.news.store import MemoryNewsStore
from tests.conftest import settings
from tests.news_fixtures import NOW

BGE_M3 = "ollama:bge-m3:567m"


# --- calibration ----------------------------------------------------------------------------------------------------


def test_model_key_strips_provider_and_tag() -> None:
    assert cal.model_key("onnx:bge-small-en-v1.5") == "bge-small-en-v1.5"
    assert cal.model_key(BGE_M3) == "bge-m3"
    assert cal.model_key("ollama:nomic-embed-text") == "nomic-embed-text"


def test_unknown_models_keep_bge_small_cutoffs_as_before() -> None:
    for name in ("hash:384", "api:text-embedding-3-small", "ollama:nomic-embed-text", ""):
        assert cal.calibration_for(name) == cal.BGE_SMALL
    assert cal.calibration_for("onnx:bge-small-en-v1.5") == cal.BGE_SMALL


def test_bge_m3_has_its_own_cutoffs() -> None:
    m3 = cal.calibration_for(BGE_M3)
    assert m3 is cal.CALIBRATIONS["bge-m3"] and m3 != cal.BGE_SMALL
    for v in (m3.ask_min_score, m3.cluster_entity_cosine, m3.cluster_join_cosine, m3.dedupe_semantic_cosine, m3.paragraph_cosine):
        assert 0.0 < v < 1.0
    assert m3.cluster_entity_cosine < m3.cluster_join_cosine < m3.dedupe_semantic_cosine


def test_paragraph_cutoff_default_follows_the_model_but_an_admin_value_wins() -> None:
    default = Quality().max_paragraph_cosine
    assert default == cal.BGE_SMALL.paragraph_cosine
    assert cal.effective_paragraph_cosine(default, BGE_M3) == cal.CALIBRATIONS["bge-m3"].paragraph_cosine
    assert cal.effective_paragraph_cosine(default, "onnx:bge-small-en-v1.5") == default
    assert cal.effective_paragraph_cosine(0.9, BGE_M3) == 0.9


def test_ask_floor_follows_the_model_unless_set(monkeypatch: pytest.MonkeyPatch) -> None:
    for k in ("EMBEDDINGS_PROVIDER", "OLLAMA_EMBED_MODEL", "EMBEDDINGS_MODEL_DIR", "ASK_BLOG_MIN_SCORE"):
        monkeypatch.delenv(k, raising=False)
    assert load_settings().ask_min_score == cal.BGE_SMALL.ask_min_score  # onnx bge-small, the image default
    monkeypatch.setenv("EMBEDDINGS_PROVIDER", "ollama")
    monkeypatch.setenv("OLLAMA_EMBED_MODEL", "bge-m3:567m")
    s = load_settings()
    assert s.ask_min_score == cal.CALIBRATIONS["bge-m3"].ask_min_score
    assert s.ollama_embed_dim == 0 and s.embeddings_timeout_s == 300.0
    monkeypatch.setenv("ASK_BLOG_MIN_SCORE", "0.5")
    monkeypatch.setenv("EMBEDDINGS_TIMEOUT_SECONDS", "5")
    s = load_settings()
    assert s.ask_min_score == 0.5 and s.embeddings_timeout_s == 10.0  # explicit floor wins; timeout clamped


# --- the Ollama provider --------------------------------------------------------------------------------------------


def ollama(dim: int, seen: list[dict[str, Any]], *, count: int | None = None) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        seen.append(body)
        n = len(body["input"]) if count is None else count
        return httpx.Response(200, json={"embeddings": [[float(i + 1)] + [0.0] * (dim - 1) for i in range(n)]})

    return httpx.MockTransport(handler)


async def test_bge_m3_needs_no_prefix_and_is_batched() -> None:
    seen: list[dict[str, Any]] = []
    e = OllamaEmbeddings("http://bge-m3.embeddings:11434/", "bge-m3:567m", transport=ollama(1024, seen))
    assert e.dim == 1024 and e.name == BGE_M3
    texts = [f"chunk {i}" for i in range(2 * OllamaEmbeddings.BATCH + 3)]
    out = await e.embed(texts)
    assert len(out) == len(texts) and all(len(v) == 1024 for v in out)
    assert [len(b["input"]) for b in seen] == [8, 8, 3]  # no single request outlasts the timeout on mk4's CPU
    assert seen[0]["model"] == "bge-m3:567m" and seen[0]["input"][0] == "chunk 0"
    await e.embed(["what is a pod?"], query=True)
    assert seen[-1]["input"] == ["what is a pod?"]
    assert np.isclose(np.linalg.norm(out[0]), 1.0)
    assert await e.embed([]) == [] and len(seen) == 4  # nothing to embed: no request


async def test_nomic_keeps_its_prefixes() -> None:
    seen: list[dict[str, Any]] = []
    e = OllamaEmbeddings("http://ollama:11434", "nomic-embed-text", transport=ollama(768, seen))
    await e.embed(["doc"])
    await e.embed(["question"], query=True)
    assert [b["input"] for b in seen] == [["search_document: doc"], ["search_query: question"]]


async def test_a_vector_of_another_size_or_count_is_refused() -> None:
    wrong_size = OllamaEmbeddings("http://x", "bge-m3:567m", transport=ollama(768, []))
    with pytest.raises(ValueError, match="expected 1024"):
        await wrong_size.embed(["a"])
    missing = OllamaEmbeddings("http://x", "bge-m3:567m", transport=ollama(1024, [], count=1))
    with pytest.raises(ValueError, match="for 2 inputs"):
        await missing.embed(["a", "b"])


def test_unknown_model_needs_its_dimension_and_a_url() -> None:
    with pytest.raises(ValueError, match="OLLAMA_EMBED_DIM"):
        OllamaEmbeddings("http://x", "mxbai-embed-large")
    assert OllamaEmbeddings("http://x", "mxbai-embed-large", dim=1024).dim == 1024
    with pytest.raises(ValueError, match="OLLAMA_URL"):
        OllamaEmbeddings("", "bge-m3:567m")


async def test_dropped_connections_and_5xx_are_retried_but_not_timeouts_or_4xx(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    waits: list[float] = []

    async def no_sleep(s: float) -> None:
        waits.append(s)

    monkeypatch.setattr(asyncio, "sleep", no_sleep)

    def flaky(*failures: Exception | int) -> httpx.MockTransport:
        left = list(failures)

        def handler(request: httpx.Request) -> httpx.Response:
            if left:
                f = left.pop(0)
                if isinstance(f, Exception):
                    raise f
                return httpx.Response(f)
            return httpx.Response(200, json={"embeddings": [[1.0] + [0.0] * 1023]})

        return httpx.MockTransport(handler)

    ok = OllamaEmbeddings("http://x", "bge-m3:567m", transport=flaky(httpx.RemoteProtocolError("Server disconnected"), 503))
    assert len((await ok.embed(["a"]))[0]) == 1024 and waits == [2, 8]
    with pytest.raises(httpx.ConnectError):  # three dropped connections: gives up
        await OllamaEmbeddings("http://x", "bge-m3:567m", transport=flaky(*[httpx.ConnectError("refused")] * 3)).embed(["a"])
    waits.clear()
    with pytest.raises(httpx.ReadTimeout):
        await OllamaEmbeddings("http://x", "bge-m3:567m", transport=flaky(httpx.ReadTimeout("slow"))).embed(["a"])
    with pytest.raises(httpx.HTTPStatusError):
        await OllamaEmbeddings("http://x", "bge-m3:567m", transport=flaky(400)).embed(["a"])
    assert waits == []


# --- the news desk after a model change -----------------------------------------------------------------------------


def deps(store: MemoryNewsStore, dim: int, calls: list[list[str]], model: str = BGE_M3, **news: Any) -> nd.DeskDeps:
    async def embed(texts: list[str]) -> list[list[float]]:
        calls.append(list(texts))
        return [[1.0] + [0.0] * (dim - 1) for _ in texts]

    return nd.DeskDeps(store=store, web=None, llm=None, embed=embed, retriever=None, settings=settings(), news=NewsSettings(**news), clock=lambda: NOW, extra={"news_embedding_model": model, "news_embedding_dim": dim})  # type: ignore[arg-type]


def item(store: MemoryNewsStore, n: int, embedding: list[float], cluster_id: str | None = None) -> str:
    iid = f"item-{n}"
    store.items[iid] = {"id": iid, "source_id": "s1", "url_hash": f"u{n}", "content_hash": f"c{n}", "minhash": None, "embedding": embedding, "cluster_id": cluster_id, "duplicate_of": None,
                        "title": f"Story {n}", "excerpt": f"Text of story {n}", "entities": {}, "published_at": NOW - timedelta(hours=10 - n), "fetched_at": NOW - timedelta(hours=10 - n)}
    return iid


async def test_window_vectors_of_the_old_model_are_re_embedded_newest_first(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(nd, "REEMBED_PER_RUN", 2)
    store = MemoryNewsStore()
    store.clock = lambda: NOW
    for n in range(3):
        item(store, n, [0.6, 0.8])  # bge-small-era vectors (here: 2 dimensions)
    calls: list[list[str]] = []
    d = deps(store, 4, calls)
    await nd.dedupe_and_cluster(d, RunRecorder(store, "r1"), [], window_days=14)
    assert calls == [["Story 2. Text of story 2", "Story 1. Text of story 1"]]  # the same text as at ingest, capped
    assert [len(store.items[f"item-{n}"]["embedding"]) for n in range(3)] == [2, 4, 4]  # the oldest waits for the next run
    await nd.dedupe_and_cluster(d, RunRecorder(store, "r2"), [], window_days=14)
    assert [len(store.items[f"item-{n}"]["embedding"]) for n in range(3)] == [4, 4, 4]
    await nd.dedupe_and_cluster(d, RunRecorder(store, "r3"), [], window_days=14)
    assert len(calls) == 2  # nothing stale any more: no embedding call


def test_a_centroid_of_the_old_model_is_rebuilt_from_current_member_vectors() -> None:
    current = {"m1": {"id": "m1", "embedding": [1.0, 0.0, 0.0]}, "m2": {"id": "m2", "embedding": [0.0, 1.0, 0.0]}}
    members = [{"id": "m1", "embedding": [0.6, 0.8]}, {"id": "m2", "embedding": [0.8, 0.6]}, {"id": "gone", "embedding": [1.0, 0.0]}]
    c = nd._centroid({"centroid": [0.7, 0.7]}, members, current, 3)
    assert c is not None and np.allclose(c, [2**-0.5, 2**-0.5, 0.0])
    assert np.allclose(nd._centroid({"centroid": [0.0, 0.0, 1.0]}, members, current, 3), [0, 0, 1])  # current size: kept
    assert nd._centroid({"centroid": [0.7, 0.7]}, members[2:], {}, 3) is None  # no current member vector: none
    assert nd._centroid({"centroid": None}, members, current, 3) is None


def test_quality_gate_takes_the_models_paraphrase_cutoff() -> None:
    store = MemoryNewsStore()
    assert nd._quality(deps(store, 1024, [])).max_paragraph_cosine == cal.CALIBRATIONS["bge-m3"].paragraph_cosine
    assert nd._quality(deps(store, 384, [], model="onnx:bge-small-en-v1.5")).max_paragraph_cosine == 0.93
    custom = deps(store, 1024, [], quality={"max_paragraph_cosine": 0.9})
    assert nd._quality(custom).max_paragraph_cosine == 0.9


def test_classifier_of_the_old_model_answers_with_rules() -> None:
    dim = 32
    model = clf.TopicModel("clf-old", ["kubernetes"], np.ones((1, dim + clf.HASH_BUCKETS + 1)), np.zeros(1), dim)
    topics = [clf.Topic("kubernetes", "Kubernetes", ["kubernetes", "pod"])]
    old = clf.predict(model, topics, embedding=[0.1] * dim, entities=set(), text="a kubernetes pod", threshold=0.55)
    assert old.method != "rules"
    new = clf.predict(model, topics, embedding=[0.1] * 1024, entities=set(), text="a kubernetes pod", threshold=0.55)
    assert new.method == "rules" and new.labels and new.labels[0][0] == "kubernetes"
