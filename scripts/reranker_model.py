#!/usr/bin/env python3
"""The PyTorch side of the reranker (app/reranker.py). The service never imports torch: it runs an ONNX file on ONNX
Runtime. This script makes and checks those files:

- `download`: a cross-encoder's PyTorch weights and tokenizer at a pinned revision (safetensors only, no pickle).
- `export`: PyTorch → ONNX (fp32), and optionally an int8 copy (ONNX Runtime dynamic quantization). For a model the
  repository does not publish as ONNX, e.g. a fine-tuned one.
- `verify`: scores real (question, passage) pairs with the PyTorch model and with an ONNX folder through the service's
  own code path (CrossEncoderReranker: `tokenizers` + ONNX Runtime), and reports how far the logits and the rankings
  differ. Run it before baking a new ONNX file into the image.

Needs the `train` dependency group (torch from PyTorch's CPU index, transformers), which CI and the image never
install:

  uv sync --group train
  uv run --group train python scripts/reranker_model.py download --out /tmp/rr/src
  uv run --group train python scripts/reranker_model.py export --src /tmp/rr/src --out /tmp/rr/fp32 --int8 /tmp/rr/int8
  uv run --group train python scripts/reranker_model.py verify --src /tmp/rr/src --onnx-dir /tmp/rr/int8 \\
      --model-dir /models/bge-small-en-v1.5      # candidates from the production embeddings (default: hashed)

`verify` reports and does not judge, unless you pass --max-abs-diff (exit 1 above it).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# The image's model (Dockerfile RERANKER_REPO / RERANKER_REV).
REPO = "cross-encoder/ms-marco-MiniLM-L6-v2"
REVISION = "233902d25c440f23af6f7d6e94d2946bac0bee0a"
FILES = ("config.json", "model.safetensors", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "vocab.txt")
INPUTS = ("input_ids", "attention_mask", "token_type_ids")
MAX_TOKENS = 512


def download(repo: str, revision: str, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        url = f"https://huggingface.co/{repo}/resolve/{revision}/{name}"
        urllib.request.urlretrieve(url, out / name)
        print(f"{name:26s} {(out / name).stat().st_size:>12,} bytes")
    (out / "source.json").write_text(json.dumps({"repo": repo, "revision": revision}, indent=2) + "\n")


def load_torch(src: Path, threads: int | None = None) -> tuple[Any, Any]:
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    if threads:
        torch.set_num_threads(threads)  # verify: the same threads as ONNX Runtime, so the two timings compare
    # safetensors only, nothing from the model repository is executed, eager attention so export traces plain ops.
    model = AutoModelForSequenceClassification.from_pretrained(src, local_files_only=True, use_safetensors=True, trust_remote_code=False, attn_implementation="eager")
    model.eval()
    tok = AutoTokenizer.from_pretrained(src, local_files_only=True)
    if model.config.num_labels != 1:
        raise SystemExit(f"expected a single-logit cross-encoder, {src} has {model.config.num_labels} labels")
    return model, tok


def torch_scores(model: Any, tok: Any, query: str, passages: list[str]) -> np.ndarray:
    import torch

    enc = tok([query] * len(passages), passages, padding=True, truncation=True, max_length=MAX_TOKENS, return_tensors="pt")
    with torch.inference_mode():
        out = model(**{k: v for k, v in enc.items() if k in INPUTS}).logits
    return out[:, 0].float().numpy()


def export(src: Path, out: Path, int8: Path | None) -> None:
    import torch

    model, tok = load_torch(src)

    class Logits(torch.nn.Module):
        def __init__(self, m: Any):
            super().__init__()
            self.m = m

        def forward(self, input_ids: Any, attention_mask: Any, token_type_ids: Any) -> Any:
            return self.m(input_ids=input_ids, attention_mask=attention_mask, token_type_ids=token_type_ids).logits

    sample = tok(["what is a cross-encoder"], ["A cross-encoder reads the question and the passage together."], return_tensors="pt", padding=True)
    args = tuple(sample[n] for n in INPUTS)
    out.mkdir(parents=True, exist_ok=True)
    axes = {n: {0: "batch", 1: "sequence"} for n in INPUTS} | {"logits": {0: "batch"}}
    t0 = time.perf_counter()
    torch.onnx.export(Logits(model).eval(), args, str(out / "model.onnx"), input_names=list(INPUTS), output_names=["logits"], dynamic_axes=axes, opset_version=17, dynamo=False)
    shutil.copy(src / "tokenizer.json", out / "tokenizer.json")
    print(f"fp32 → {out / 'model.onnx'} ({(out / 'model.onnx').stat().st_size:,} bytes, {time.perf_counter() - t0:.1f} s)")
    if int8 is not None:
        from onnxruntime.quantization import QuantType, quantize_dynamic

        int8.mkdir(parents=True, exist_ok=True)
        quantize_dynamic(str(out / "model.onnx"), str(int8 / "model.onnx"), weight_type=QuantType.QInt8)
        shutil.copy(src / "tokenizer.json", int8 / "tokenizer.json")
        print(f"int8 → {int8 / 'model.onnx'} ({(int8 / 'model.onnx').stat().st_size:,} bytes)")


async def pairs(model_dir: str | None, n: int) -> list[tuple[str, list[str]]]:
    """Each eval question with the passages the service would rerank for it: the diversified top n of the corpus."""
    from app.embeddings import HashEmbeddings, OnnxEmbeddings
    from app.rag_eval import BLOG_DIR, LocalIndex, load_articles, load_eval_set
    from app.reranker import passage_text
    from app.retrieval import RetrievalConfig

    emb = OnnxEmbeddings(model_dir) if model_dir else HashEmbeddings()
    ix = LocalIndex(emb, RetrievalConfig(mode="vector"), chunker="token")
    await ix.build(load_articles(BLOG_DIR))
    return [(q.question, [passage_text(h) for h in await ix.search(q.question, n)]) for q in load_eval_set()]


def verify(src: Path, onnx_dir: Path, model_dir: str | None, n: int, threads: int, max_abs_diff: float | None, json_out: Path | None) -> int:
    from scipy.stats import kendalltau

    from app.reranker import CrossEncoderReranker

    model, tok = load_torch(src, threads)
    onnx = CrossEncoderReranker(str(onnx_dir), threads=threads)
    rows = asyncio.run(pairs(model_dir, n))
    diffs: list[float] = []
    taus: list[float] = []
    same_top1 = same_top3 = 0
    t_torch = t_onnx = 0.0
    for query, passages in rows:
        if len(passages) < 2:
            continue
        t0 = time.perf_counter()
        ref = torch_scores(model, tok, query, passages)
        t1 = time.perf_counter()
        got = onnx.scores(query, passages)
        t2 = time.perf_counter()
        t_torch, t_onnx = t_torch + t1 - t0, t_onnx + t2 - t1
        diffs.extend(np.abs(ref - got).tolist())
        taus.append(float(kendalltau(ref, got).statistic))
        a, b = np.argsort(-ref, kind="stable"), np.argsort(-got, kind="stable")
        same_top1 += int(a[0] == b[0])
        same_top3 += int(set(a[:3].tolist()) == set(b[:3].tolist()))
    q = len(taus)
    report = {
        "onnx": str(onnx_dir),
        "pytorch": str(src),
        "candidates": "bge-small" if model_dir else "hashed",
        "threads": threads,
        "questions": q,
        "pairs": len(diffs),
        "max_abs_logit_diff": round(max(diffs), 5),
        "mean_abs_logit_diff": round(float(np.mean(diffs)), 5),
        "mean_kendall_tau": round(float(np.mean(taus)), 4),
        "same_top1": f"{same_top1}/{q}",
        "same_top3_set": f"{same_top3}/{q}",
        "seconds_pytorch": round(t_torch, 1),
        "seconds_onnx": round(t_onnx, 1),
    }
    print(json.dumps(report, indent=2))
    if json_out:
        json_out.write_text(json.dumps(report, indent=2) + "\n")
    if max_abs_diff is not None and report["max_abs_logit_diff"] > max_abs_diff:
        print(f"max |Δ logit| {report['max_abs_logit_diff']} > --max-abs-diff {max_abs_diff}", file=sys.stderr)
        return 1
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("download", help="PyTorch weights + tokenizer at a pinned revision")
    d.add_argument("--repo", default=REPO)
    d.add_argument("--revision", default=REVISION)
    d.add_argument("--out", type=Path, required=True)
    e = sub.add_parser("export", help="PyTorch → ONNX (fp32), optionally an int8 copy")
    e.add_argument("--src", type=Path, required=True)
    e.add_argument("--out", type=Path, required=True)
    e.add_argument("--int8", type=Path, default=None)
    v = sub.add_parser("verify", help="compare an ONNX folder with the PyTorch model on real pairs")
    v.add_argument("--src", type=Path, required=True)
    v.add_argument("--onnx-dir", type=Path, required=True)
    v.add_argument("--model-dir", default=None, help="bge-small ONNX folder: rank the candidates as production does (default: hashed embeddings)")
    v.add_argument("--candidates", type=int, default=20, help="passages per question (RAG_CANDIDATES)")
    v.add_argument("--threads", type=int, default=2, help="for both PyTorch and ONNX Runtime")
    v.add_argument("--max-abs-diff", type=float, default=None)
    v.add_argument("--json-out", type=Path, default=None)
    a = ap.parse_args()
    if a.cmd == "download":
        download(a.repo, a.revision, a.out)
        return 0
    if a.cmd == "export":
        export(a.src, a.out, a.int8)
        return 0
    return verify(a.src, a.onnx_dir, a.model_dir, a.candidates, a.threads, a.max_abs_diff, a.json_out)


if __name__ == "__main__":
    raise SystemExit(main())
