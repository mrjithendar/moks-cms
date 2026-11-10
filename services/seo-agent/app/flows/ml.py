"""seo_ml_flow (SEO v5, docs/seo/ML.md): weekly CronJob `seo-flow-ml` + manual runs. CrewAI Flows stay the only
orchestrator; the ML is plain Python in app/seo_ml/train.py, one step per model, writing Postgres tables the web app
reads (with a fallback to its rules).

Each model step runs even if an earlier one failed (they are independent); the run ends `failed` if any step failed,
after the others have written their results, so `SeoMlFlowFailing` sees it.
"""

from __future__ import annotations

from typing import Any, ClassVar

from crewai.flow import listen, persist, start

from .. import metrics
from ..runs import INSTANCE_ONLY
from ..seo_ml import train as tr
from ..state import MlState
from .base import SeoFlow


@persist(INSTANCE_ONLY)
class SeoMlFlow(SeoFlow[MlState]):
    FLOW: ClassVar[str] = "seo_ml_flow"

    def _wanted(self, name: str) -> bool:
        return not self.state.models or name in self.state.models

    async def _run(self, name: str, fn: Any) -> None:
        if not self._wanted(name):
            return
        async with self.step(name):
            try:
                self.state.results[name] = await fn()
            except Exception as e:
                self.state.errors.append(f"{name}: {type(e).__name__}: {str(e)[:300]}")
                self.state.results[name] = {"error": type(e).__name__}
                if name in metrics.ML_MODELS:
                    metrics.ML_TRAIN_RUNS.labels(model=name, status="failed").inc()

    @property
    def _store(self) -> Any:
        store = self.deps.extra.get("ml_store")
        if store is None:
            raise RuntimeError("ml store is not configured")
        return store

    @property
    def _embed(self) -> Any:
        return self.deps.extra["ml_embed"]

    @property
    def _model_name(self) -> str:
        return str(self.deps.extra.get("ml_embed_model", "unknown"))

    @start()
    async def decay(self) -> None:
        await self._run("decay", lambda: tr.run_decay(self._store))

    @listen(decay)
    async def query_clusters(self) -> None:
        s = self.deps.settings
        await self._run("query_clusters", lambda: tr.run_clusters(self._store, self._embed, self._model_name, llm=self.deps.llm, suggest_model=s.classify_model, suggest_labels=self.state.suggest_labels))

    @listen(query_clusters)
    async def intent(self) -> None:
        await self._run("intent", lambda: tr.run_intent(self._store, self._embed, self._model_name))

    @listen(intent)
    async def priority(self) -> None:
        await self._run("priority", lambda: tr.run_priority(self._store))

    @listen(priority)
    async def related(self) -> None:
        await self._run("related", lambda: tr.run_related(self._store, self.deps.retriever))

    @listen(related)
    async def rag_eval(self) -> None:
        await self._run("rag_eval", lambda: tr.run_rag_eval(self._store, self.deps.retriever))

    @listen(rag_eval)
    async def finish(self) -> None:
        async with self.step("finish"):
            if self.state.errors:
                raise RuntimeError("; ".join(self.state.errors)[:1000])
            self.state.outcome = "done"
