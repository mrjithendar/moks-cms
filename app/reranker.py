"""Optional cross-encoder reranker (docs/seo/RAG.md "Reranker"). OFF by default (RAG_RERANKER_ENABLED=false) and not in
the image: enabling it needs an ONNX export of a cross-encoder (e.g. BAAI/bge-reranker-base) mounted at
RAG_RERANKER_DIR (model.onnx + tokenizer.json).

Activation rule (v5 brief): only if it improves the eval set's Recall@3 by ≥ 3 points AND p95 search latency stays
under 400 ms on Minikube. On the v5 eval set Recall@3 is already 100 % without it, so it cannot pass the first test
(RAG.md records the measurement); the code stays so a harder eval set or a bigger corpus can re-test it.

CPU only, ONNX Runtime, no torch. Reranks the fused top-N (20) to the final top-k: score = the model's relevance
logit for (question, title › heading path + excerpt).
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import numpy as np


class CrossEncoderReranker:
    MAX_TOKENS = 512
    PASSAGE_CHARS = 2000

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

    def _scores(self, query: str, passages: list[str]) -> np.ndarray:
        enc = self.tok.encode_batch([(query, p) for p in passages])
        feed = {"input_ids": np.array([e.ids for e in enc], dtype=np.int64), "attention_mask": np.array([e.attention_mask for e in enc], dtype=np.int64)}
        if "token_type_ids" in self.inputs:
            feed["token_type_ids"] = np.array([e.type_ids for e in enc], dtype=np.int64)
        out = self.session.run(None, feed)[0]
        return np.asarray(out).reshape(len(passages), -1)[:, 0]

    async def rerank(self, query: str, hits: list[Any], k: int) -> list[Any]:
        if not hits:
            return []
        passages = [f"{h.title} › {h.heading_path}\n{h.content[: self.PASSAGE_CHARS]}" for h in hits]
        scores = await asyncio.to_thread(self._scores, query, passages)
        order = np.argsort(-scores, kind="stable")
        return [hits[int(i)] for i in order[:k]]
