"""The cross-encoder reranker's gate (app/reranker.py RerankGate) and how search uses it (app/index.py ranked_hits):
off by default, live settings, and search never fails or loses a passage because of it. Plus the image and dependency
rules: the model is baked and pinned, PyTorch stays out of the image and out of CI."""

from __future__ import annotations

import asyncio
import os
import tomllib
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from app import metrics
from app.admin_settings.groups import GROUPS
from app.config import Settings, load_settings
from app.index import ranked_hits
from app.reranker import RerankGate, passage_text
from app.retrieval import Candidate, RetrievalConfig, fuse

ROOT = Path(__file__).resolve().parent.parent


def _cands(n: int, per_article: int = 1) -> list[Candidate]:
    return [Candidate(f"k{i}", f"A{i // per_article}", f"T{i}", f"/blog/a{i // per_article}", "H", f"s{i}", f"text {i}", 0.9 - i / 100, vector_rank=i + 1) for i in range(n)]


def _settings(**kw: Any) -> SimpleNamespace:
    base = {"rag_reranker_enabled": True, "rag_reranker_dir": "/models/rr", "rag_reranker_threads": 2, "rag_reranker_candidates": 0, "rag_reranker_timeout_ms": 0, "rag_reranker_max_concurrent": 0}
    return SimpleNamespace(**{**base, **kw})


class Reverse:
    """A model that ranks the passages in reverse; `hold` keeps it busy until released."""

    name = "fake:reverse"

    def __init__(self, hold: asyncio.Event | None = None, fail: bool = False, drop: bool = False):
        self.hold, self.fail, self.drop = hold, fail, drop
        self.calls: list[int] = []

    async def rerank(self, query: str, hits: list[Any], k: int) -> list[Any]:
        self.calls.append(len(hits))
        if self.hold is not None:
            await self.hold.wait()
        if self.fail:
            raise RuntimeError("model failed")
        out = list(reversed(hits))[:k]
        return out[1:] if self.drop else out


def _gate(model: Any = None, **kw: Any) -> tuple[RerankGate, list[tuple[str, int]]]:
    loads: list[tuple[str, int]] = []

    def factory(path: str, threads: int) -> Any:
        loads.append((path, threads))
        if model is None:
            raise FileNotFoundError(path)
        return model

    return RerankGate(_settings(**kw), factory=factory), loads


def _count(outcome: str) -> float:
    return metrics.REGISTRY.get_sample_value("seo_rag_rerank_total", {"outcome": outcome}) or 0.0


CFG = RetrievalConfig(mode="vector", candidates=8, max_per_article=3)


async def test_off_by_default_and_the_fused_order_is_unchanged() -> None:
    s = load_settings({})
    assert (s.rag_reranker_enabled, s.rag_reranker_candidates, s.rag_reranker_timeout_ms, s.rag_reranker_max_concurrent) == (False, 0, 0, 0)
    assert load_settings({"RAG_RERANKER_DIR": "/m"}).rag_reranker_enabled is False  # the image sets the folder; the switch stays off
    gate, loads = _gate(Reverse(), rag_reranker_enabled=False)
    fused = fuse(_cands(10), CFG)
    assert [h.anchor for h in await ranked_hits(fused, CFG, 4, "q", gate)] == ["s0", "s1", "s2", "s3"]
    assert [h.anchor for h in await ranked_hits(fused, CFG, 4, "q", None)] == ["s0", "s1", "s2", "s3"]
    assert loads == []  # never loaded while off
    on = RerankGate(_settings(rag_reranker_dir=""), factory=lambda *_: Reverse())
    assert not on.enabled  # switched on without a model folder: off


async def test_switched_on_it_reorders_the_candidates_and_keeps_k() -> None:
    model = Reverse()
    gate, loads = _gate(model, rag_reranker_threads=3)
    before = _count("applied")
    out = await ranked_hits(fuse(_cands(10), CFG), CFG, 4, "q", gate)
    assert [h.anchor for h in out] == ["s7", "s6", "s5", "s4"]  # the model's order over all 8 candidates
    assert model.calls == [8] and loads == [("/models/rr", 3)]
    assert _count("applied") == before + 1
    await ranked_hits(fuse(_cands(10), CFG), CFG, 4, "q", gate)
    assert len(loads) == 1  # loaded once


async def test_a_smaller_window_reorders_only_its_head_and_still_returns_k() -> None:
    model = Reverse()
    gate, _ = _gate(model, rag_reranker_candidates=3)
    out = await ranked_hits(fuse(_cands(10), CFG), CFG, 6, "q", gate)
    assert model.calls == [3]
    assert [h.anchor for h in out] == ["s2", "s1", "s0", "s3", "s4", "s5"]


async def test_the_window_respects_the_per_article_cap() -> None:
    gate, _ = _gate(Reverse())
    out = await ranked_hits(fuse(_cands(12, per_article=4), CFG), CFG, 6, "q", gate)
    per: dict[str, int] = {}
    for h in out:
        per[h.article_id] = per.get(h.article_id, 0) + 1
    assert max(per.values()) <= 3


async def test_a_model_that_cannot_load_leaves_search_as_it_was_and_is_not_retried() -> None:
    gate, loads = _gate(None)
    before = _count("unavailable")
    for _ in range(3):
        out = await ranked_hits(fuse(_cands(10), CFG), CFG, 4, "q", gate)
        assert [h.anchor for h in out] == ["s0", "s1", "s2", "s3"]
    assert len(loads) == 1 and gate.load_error == "FileNotFoundError"
    assert _count("unavailable") == before + 3
    assert gate.status()["load_error"] == "FileNotFoundError"


async def test_a_failing_or_misbehaving_model_keeps_the_fused_order() -> None:
    for model in (Reverse(fail=True), Reverse(drop=True)):
        gate, _ = _gate(model)
        before = _count("error")
        out = await ranked_hits(fuse(_cands(10), CFG), CFG, 4, "q", gate)
        assert [h.anchor for h in out] == ["s0", "s1", "s2", "s3"]
        assert _count("error") == before + 1
        await asyncio.sleep(0)
        assert gate.running == 0


async def test_past_the_deadline_search_goes_on_and_the_slot_waits_for_the_work() -> None:
    hold = asyncio.Event()
    model = Reverse(hold=hold)
    gate, _ = _gate(model, rag_reranker_timeout_ms=20, rag_reranker_max_concurrent=1)
    before_timeout, before_busy = _count("timeout"), _count("busy")
    out = await ranked_hits(fuse(_cands(10), CFG), CFG, 4, "q", gate)
    assert [h.anchor for h in out] == ["s0", "s1", "s2", "s3"] and _count("timeout") == before_timeout + 1
    # The timed-out work still runs (a native call cannot be stopped), so it keeps its slot: the next search skips.
    assert gate.running == 1
    out = await ranked_hits(fuse(_cands(10), CFG), CFG, 4, "q", gate)
    assert [h.anchor for h in out] == ["s0", "s1", "s2", "s3"] and _count("busy") == before_busy + 1
    assert model.calls == [8]
    hold.set()
    await asyncio.sleep(0.01)
    assert gate.running == 0
    out = await ranked_hits(fuse(_cands(10), CFG), CFG, 4, "q", gate)
    assert out[0].anchor == "s7"


async def test_settings_apply_live_through_the_shared_object() -> None:
    s = _settings(rag_reranker_enabled=False)
    gate = RerankGate(s, factory=lambda *_: Reverse())
    fused = fuse(_cands(10), CFG)
    assert (await ranked_hits(fused, CFG, 4, "q", gate))[0].anchor == "s0"
    s.rag_reranker_enabled = True  # what apply_live does to the running Settings
    assert (await ranked_hits(fused, CFG, 4, "q", gate))[0].anchor == "s7"
    s.rag_reranker_candidates = 2
    assert [h.anchor for h in await ranked_hits(fused, CFG, 4, "q", gate)] == ["s1", "s0", "s2", "s3"]


def test_the_settings_are_registered_with_the_right_apply_and_no_preset_limits() -> None:
    fields = {f.env: f for g in GROUPS if g.id == "retrieval" for f in g.fields}
    live = {"RAG_RERANKER_ENABLED", "RAG_RERANKER_CANDIDATES", "RAG_RERANKER_TIMEOUT_MS", "RAG_RERANKER_MAX_CONCURRENT"}
    assert live <= set(fields) and all(fields[e].apply == "live" for e in live)
    assert fields["RAG_RERANKER_THREADS"].apply == "restart"  # copied into the ONNX Runtime session when it loads
    assert "RAG_RERANKER_DIR" not in {f.env for g in GROUPS for f in g.fields}  # a path: the image's, not an admin's
    # The three limits start at 0 = no limit; the owner sets them in Settings.
    assert (Settings.rag_reranker_candidates, Settings.rag_reranker_timeout_ms, Settings.rag_reranker_max_concurrent) == (0, 0, 0)
    s = load_settings({"RAG_RERANKER_ENABLED": "true", "RAG_RERANKER_CANDIDATES": "500", "RAG_RERANKER_TIMEOUT_MS": "99999", "RAG_RERANKER_MAX_CONCURRENT": "x", "RAG_RERANKER_THREADS": "0"})
    assert (s.rag_reranker_enabled, s.rag_reranker_candidates, s.rag_reranker_timeout_ms, s.rag_reranker_max_concurrent, s.rag_reranker_threads) == (True, 100, 30000, 0, 1)
    for e in live - {"RAG_RERANKER_ENABLED"}:
        assert fields[e].min == 0, e  # 0 must be savable: it means no limit


def test_the_passage_text_is_title_heading_and_clipped_content() -> None:
    h = SimpleNamespace(title="Istio", heading_path="mTLS › STRICT", content="x" * 5000)
    assert passage_text(h) == "Istio › mTLS › STRICT\n" + "x" * 2000


def test_the_model_is_baked_pinned_and_pytorch_stays_out_of_the_image_and_ci() -> None:
    docker = (ROOT.parent / "Dockerfile").read_text()  # the repository's one Dockerfile (D-105)
    assert "ARG RERANKER_REV=233902d25c440f23af6f7d6e94d2946bac0bee0a" in docker
    assert 'echo "${RERANKER_SHA256}  /models/ms-marco-MiniLM-L6-v2/model.onnx" | sha256sum -c -' in docker
    assert "RAG_RERANKER_DIR=/models/ms-marco-MiniLM-L6-v2" in docker
    assert "uv sync --frozen --no-dev --no-install-project" in docker  # installs no dependency group
    assert "torch" not in docker.split("FROM python:${PYTHON_VERSION}-slim-trixie AS runtime\n", 1)[1].lower()  # the runtime stage
    py = tomllib.loads((ROOT / "pyproject.toml").read_text())
    deps = " ".join(py["project"]["dependencies"]).lower()
    assert "torch" not in deps and "transformers" not in deps
    assert any(d.startswith("torch==") for d in py["dependency-groups"]["train"])
    assert "default-groups" not in py["tool"]["uv"]  # only `dev` is installed by `uv sync` (CI)
    assert py["tool"]["uv"]["sources"]["torch"] == [{"index": "pytorch-cpu"}]
    assert {"name": "pytorch-cpu", "url": "https://download.pytorch.org/whl/cpu", "explicit": True} in py["tool"]["uv"]["index"]
    ci = (ROOT.parent / ".github" / "workflows" / "ci-moks-cms.yml").read_text()
    assert "--group train" not in ci and "--all-groups" not in ci
    assert "seo-agent/scripts" in (ROOT.parent / ".dockerignore").read_text().split()


MODEL_DIR = os.environ.get("RAG_RERANKER_DIR", "/models/ms-marco-MiniLM-L6-v2")


@pytest.mark.skipif(not (Path(MODEL_DIR) / "model.onnx").exists(), reason="needs the reranker model (the image's, or RAG_RERANKER_DIR)")
async def test_the_real_model_ranks_the_answer_first() -> None:
    gate = RerankGate(_settings(rag_reranker_dir=MODEL_DIR))
    hits = [
        SimpleNamespace(title="Valkey", heading_path="Sentinel", content="Sentinel promotes a replica when the primary fails."),
        SimpleNamespace(title="Istio", heading_path="mTLS", content="STRICT mode rejects plain-text traffic between sidecars."),
    ]
    out, outcome = await gate.rerank("how does istio strict mtls treat plain text traffic", hits)
    assert outcome == "applied" and out[0].title == "Istio"
