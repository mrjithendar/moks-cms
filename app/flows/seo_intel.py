"""seo_intel_sync_flow: the database's keyword clusters and Search Console performance → seo_intel in moks-rag.

    collect (seo_ml_query_clusters + 28 days of seo_gsc_query_daily → documents) → ingest (new and changed ones;
    gone ones deleted)

No model is involved. Documents and their ids are described in app/seo_intel.py. A document whose content did not
change since it was last sent is skipped (`full` sends everything again). The sync stops at the first request that
still fails after its retries; what it sent before that is recorded, so the next run carries on. Without moks-rag
(RAG_API_URL or RAG_BEARER_TOKEN unset) the run succeeds with outcome `not_configured` and does nothing.

Run it after seo_ml_flow (which writes the clusters) and gsc_sync_flow, e.g. on a schedule of its own.
"""

from __future__ import annotations

from typing import Any, ClassVar

from crewai.flow import listen, persist, start
from pydantic import PrivateAttr

from .. import seo_intel
from ..runs import INSTANCE_ONLY
from ..state import SeoIntelSyncState
from .base import SeoFlow

PERFORMANCE_ROWS = 20_000  # page × query rows read for one run (a size guard, not a choice of what to send)


@persist(INSTANCE_ONLY)
class SeoIntelSyncFlow(SeoFlow[SeoIntelSyncState]):
    FLOW: ClassVar[str] = "seo_intel_sync_flow"
    _docs: list[Any] = PrivateAttr(default_factory=list)  # collect → ingest; not in the persisted state (can be large)

    @start()
    async def collect(self) -> None:
        async with self.step("collect") as rec:
            s, extra = self.state, self.deps.extra
            if extra.get("rag") is None:
                s.outcome = "not_configured"
                rec.detail["reason"] = "RAG_API_URL or RAG_BEARER_TOKEN is not set"
                return
            ml = extra["ml_store"]
            site = self.deps.settings.site_url
            performance = await ml.query_performance(seo_intel.GSC_DAYS, PERFORMANCE_ROWS)
            clusters = await ml.query_clusters()
            docs = seo_intel.cluster_docs(clusters, performance, site) + seo_intel.page_docs(performance, site)
            self._docs = docs
            s.result = {"performance_rows": len(performance), "cluster_rows": len(clusters), "documents": len(docs)}
            rec.detail.update(s.result)

    @listen(collect)
    async def ingest(self) -> None:
        async with self.step("ingest") as rec:
            s, extra = self.state, self.deps.extra
            if s.outcome == "not_configured":
                return
            docs, self._docs = self._docs, []
            try:
                r = await seo_intel.sync(extra["rag"], extra["rag_docs"], docs, full=s.full)
            except seo_intel.SyncStopped as e:
                s.result.update(e.result)
                rec.detail.update({k: v for k, v in e.result.items() if k != "by_type"})
                raise
            s.result.update(r)
            rec.detail.update({k: v for k, v in r.items() if k != "by_type"})
            s.outcome = "synced" if r["ingested"] or r["deleted"] else "unchanged"
