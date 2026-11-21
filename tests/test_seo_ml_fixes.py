"""Two failures of the weekly seo_ml_flow on mk4 (2026-11-22):

- rag_eval: FileNotFoundError /srv/tests/fixtures/rag_eval.yaml. The image leaves tests/ out (.dockerignore), so the
  live retrieval evaluation could never find its question set. It ships with the app now (app/data).
- query_clusters: Truncated: no structured output (stop_reason=max_tokens). The label suggestions asked for 200 queries
  copied back in one answer; they go in batches now, and a batch that still fails is left out instead of failing.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from app.llm import Truncated
from app.rag_eval import EVAL_PATH, load_eval_set
from app.seo_ml import train as tr

ROOT = Path(__file__).resolve().parent.parent


def test_the_eval_set_ships_in_the_image() -> None:
    assert EVAL_PATH.exists() and EVAL_PATH.is_relative_to(ROOT / "app")  # app/ is copied into the image
    ignored = [line.strip() for line in (ROOT / ".dockerignore").read_text().splitlines()]
    assert "tests" in ignored and "app" not in ignored
    assert "COPY app ./app" in (ROOT / "Dockerfile").read_text()
    assert len(load_eval_set()) >= 20


async def test_the_live_eval_is_skipped_not_failed_without_its_question_set(monkeypatch: Any, tmp_path: Path) -> None:
    import app.rag_eval as re_mod

    class Retriever:
        available = True

    monkeypatch.setattr(re_mod, "EVAL_PATH", tmp_path / "missing.yaml")
    assert (await tr.run_rag_eval(None, Retriever()))["skipped"].startswith("evaluation set not found")  # type: ignore[arg-type]


class Store:
    def __init__(self) -> None:
        self.tasks: list[tuple[str, dict[str, Any]]] = []

    async def labels(self, kind: str) -> list[dict[str, Any]]:
        return []

    async def add_label_tasks(self, kind: str, items: list[tuple[str, dict[str, Any]]]) -> int:
        self.tasks.extend(items)
        return len(items)


class Llm:
    def __init__(self, fail_batch: int) -> None:
        self.batches: list[int] = []
        self.fail_batch = fail_batch

    async def structured(self, spec: Any, model: Any) -> tuple[Any, Any]:
        import json
        import re

        queries = json.loads(re.search(r"\n(\[.*\])\n", spec.user, re.S).group(1))  # the data block's list
        self.batches.append(len(queries))
        if len(self.batches) == self.fail_batch:
            raise Truncated("no structured output (stop_reason=max_tokens)")
        return model.model_validate({"groups": [{"name": f"topic {len(self.batches)}", "queries": queries}]}), None


async def test_label_suggestions_go_in_batches_and_a_failed_batch_is_left_out() -> None:
    rows = [{"query": f"kubernetes question {n}", "impressions": 1000 - n} for n in range(120)]
    store, llm = Store(), Llm(fail_batch=2)
    n = await tr.suggest_cluster_labels(store, llm, "claude-haiku-5-5", rows)
    assert n == 120 and llm.batches == [50, 50, 20] and all(b <= tr.SUGGEST_BATCH for b in llm.batches)
    groups = dict(store.tasks)
    sample = [q for q, _ in store.tasks]
    assert {groups[q]["group"] for q in sample[:50]} == {"topic 1"}
    assert all(groups[q]["group"] == q for q in sample[50:100])  # the truncated batch: each its own name, to confirm
    assert {groups[q]["group"] for q in sample[100:]} == {"topic 3"}
