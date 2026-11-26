"""Cross-encoder reranker for article search (Ask the Blog, the crews' vector_search, MCP search). OFF by default
(RAG_RERANKER_ENABLED, Admin → AI & SEO → Settings → Retrieval, live).

The model: cross-encoder/ms-marco-MiniLM-L6-v2 at revision 233902d (Apache-2.0), its int8 ONNX export
(`onnx/model_qint8_arm64.onnx`), baked into the image at RAG_RERANKER_DIR=/models/ms-marco-MiniLM-L6-v2 with a pinned
sha256 like the embeddings model. CPU only, ONNX Runtime: PyTorch is used outside the service only, to export a model
and to check an ONNX file against the PyTorch model it came from (scripts/reranker_model.py, the `train` dependency
group).

It reorders the diversified top-N candidates (RAG_CANDIDATES, or the first RAG_RERANKER_CANDIDATES of them) by the
model's relevance logit for (question, "title › heading path" + passage). `Hit.score` stays the chunk's cosine, so Ask
the Blog's floor is applied exactly as before: the reranker only changes the order of passages that passed it.

Activation rule (v5 brief): +3 points of Recall@3 on the eval set AND p95 search latency under 400 ms. Measured
2026-11-22 on the 95-question set (scripts/rag_eval.py `token-vector-rerank`, the whole search timed, an M3 Pro, not
mk4): Recall@3 90.5 % → 95.2 % reranking every candidate (≤ 20 after the per-article cap, ~10 on average), fp32 and int8 alike (MRR 0.865 → 0.907 fp32, 0.899
int8); p95 1,195 ms (fp32) / 559 ms (int8) with 2 threads, 349 ms (int8) with 4. Reranking 10 or 6 candidates is
faster but gains only 2.4 / 1.2 points (README "The reranker and PyTorch"). Those runs have no similarity floor (the
crews' and MCP search). Ask the Blog filters by ASK_BLOG_MIN_SCORE first: at 0.66 Recall@3 goes 85.7 % → 88.1 % (+2.4,
under the rule), at the calibrated 0.59 the full 90.5 % → 95.2 %. The cost knobs are settings (candidates, threads);
mk4's p95 has to be measured there before switching it on.

Search never fails because of the reranker (`RerankGate`): off, model missing or unloadable, at its concurrency
limit, past its deadline or failing, the search returns the fused order it would have returned without it.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

from . import metrics

log = logging.getLogger("seo_agent.reranker")

PASSAGE_CHARS = 2000


def passage_text(hit: Any) -> str:
    """What the model reads for one candidate: the same text in the service, the eval and scripts/reranker_model.py."""
    return f"{hit.title} › {hit.heading_path}\n{hit.content[:PASSAGE_CHARS]}"


class CrossEncoderReranker:
    MAX_TOKENS = 512

    def __init__(self, model_dir: str, threads: int = 2):
        import onnxruntime as ort
        from tokenizers import Tokenizer

        d = Path(model_dir)
        self.name = f"onnx:{d.name}"
        self.tok = Tokenizer.from_file(str(d / "tokenizer.json"))
        self.tok.enable_truncation(max_length=self.MAX_TOKENS)
        self.tok.enable_padding(pad_id=self.tok.token_to_id("<pad>") or self.tok.token_to_id("[PAD]") or 0)
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        opts.inter_op_num_threads = 1
        opts.enable_cpu_mem_arena = False
        self.session = ort.InferenceSession(str(d / "model.onnx"), sess_options=opts, providers=["CPUExecutionProvider"])
        self.inputs = {i.name for i in self.session.get_inputs()}

    def scores(self, query: str, passages: list[str]) -> np.ndarray:
        enc = self.tok.encode_batch([(query, p) for p in passages])
        feed = {"input_ids": np.array([e.ids for e in enc], dtype=np.int64), "attention_mask": np.array([e.attention_mask for e in enc], dtype=np.int64)}
        if "token_type_ids" in self.inputs:
            feed["token_type_ids"] = np.array([e.type_ids for e in enc], dtype=np.int64)
        out = self.session.run(None, feed)[0]
        return np.asarray(out).reshape(len(passages), -1)[:, 0]

    async def rerank(self, query: str, hits: list[Any], k: int) -> list[Any]:
        if not hits:
            return []
        scores = await asyncio.to_thread(self.scores, query, [passage_text(h) for h in hits])
        order = np.argsort(-scores, kind="stable")
        return [hits[int(i)] for i in order[:k]]


class RerankGate:
    """Applies the reranker to one search, or says why it did not. Reads the switch and the limits from the shared
    Settings object on every search (live settings), loads the model on first use and remembers a failed load until
    the next restart.

    - RAG_RERANKER_CANDIDATES: how many of the candidates the model reads (0 = all of them).
    - RAG_RERANKER_TIMEOUT_MS: how long a search waits for it (0 = no deadline).
    - RAG_RERANKER_MAX_CONCURRENT: reranks running at once; beyond that a search skips it (0 = no limit).

    A rerank's slot is released when its computation ends, not when the search stops waiting: a native ONNX Runtime
    call cannot be interrupted, so after a timeout the work still holds a CPU, and freeing the slot early would let
    timed-out work pile up and slow down every search after it (the moks-reranker lesson).
    """

    def __init__(self, settings: Any, factory: Callable[[str, int], Any] = CrossEncoderReranker):
        self.settings = settings
        self._factory = factory
        self._model: Any = None
        self.load_error: str | None = None
        self._loading = asyncio.Lock()
        self.running = 0

    @property
    def model_dir(self) -> str:
        return str(getattr(self.settings, "rag_reranker_dir", "") or "")

    @property
    def enabled(self) -> bool:
        return bool(getattr(self.settings, "rag_reranker_enabled", False)) and bool(self.model_dir)

    @property
    def name(self) -> str:
        return getattr(self._model, "name", f"onnx:{Path(self.model_dir).name}") if self.model_dir else ""

    def window(self, candidates: int) -> int:
        n = int(getattr(self.settings, "rag_reranker_candidates", 0) or 0)
        return min(n, candidates) if n > 0 else candidates

    def status(self) -> dict[str, Any]:
        return {"enabled": self.enabled, "model": self.name, "loaded": self._model is not None, "load_error": self.load_error, "running": self.running}

    async def load(self) -> Any:
        if self._model is not None or self.load_error is not None:
            return self._model
        async with self._loading:
            if self._model is None and self.load_error is None:
                threads = max(1, int(getattr(self.settings, "rag_reranker_threads", 2) or 2))
                try:
                    self._model = await asyncio.to_thread(self._factory, self.model_dir, threads)
                    log.info("reranker loaded", extra={"event": "reranker_loaded", "model": self.name, "threads": threads})
                except Exception as e:  # missing files, a broken model: search goes on without it
                    self.load_error = type(e).__name__
                    log.warning("reranker not loaded; search keeps the fused order", extra={"event": "reranker_load_failed", "error": self.load_error})
        return self._model

    def _done(self, task: asyncio.Future, started: float) -> None:
        self.running -= 1
        metrics.RAG_RERANK_SECONDS.observe(time.monotonic() - started)
        if not task.cancelled() and task.exception() is not None:  # retrieved here, so a late failure is not "never retrieved"
            log.warning("reranker failed", extra={"event": "reranker_failed", "error": type(task.exception()).__name__})

    async def rerank(self, query: str, hits: list[Any]) -> tuple[list[Any], str]:
        """(all of `hits` in the model's order, "applied"), or (`hits` unchanged, why not: off | unavailable | busy |
        timeout | error)."""
        if not self.enabled:
            return hits, "off"
        if not hits:
            return hits, "applied"
        model = await self.load()
        if model is None:
            return hits, "unavailable"
        limit = int(getattr(self.settings, "rag_reranker_max_concurrent", 0) or 0)
        if limit > 0 and self.running >= limit:
            return hits, "busy"
        self.running += 1
        started = time.monotonic()
        task = asyncio.ensure_future(model.rerank(query, hits, len(hits)))
        task.add_done_callback(lambda t: self._done(t, started))
        timeout_ms = int(getattr(self.settings, "rag_reranker_timeout_ms", 0) or 0)
        try:
            out = await asyncio.wait_for(asyncio.shield(task), timeout_ms / 1000 if timeout_ms > 0 else None)
        except TimeoutError:
            return hits, "timeout"
        except Exception:
            return hits, "error"
        if sorted(map(id, out)) != sorted(map(id, hits)):  # the same passages, only reordered
            return hits, "error"
        return list(out), "applied"
