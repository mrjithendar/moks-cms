"""seo_intel_sync_flow: the database's keyword clusters and Search Console performance → seo_intel in moks-rag.

    collect (seo_ml_query_clusters + 28 days of seo_gsc_query_daily → documents) → ingest (new and changed ones;
    gone ones deleted)

No model is involved. Documents and their ids are described in app/seo_intel.py. A document whose content did not
change since it was last sent is skipped (`full` sends everything again). The sync stops at the first request that
still fails after its retries; what it sent before that is recorded, so the next run carries on. Without moks-rag
(RAG_API_URL or RAG_BEARER_TOKEN unset) the run succeeds with outcome `not_configured` and does nothing.

Run it after seo_ml_flow (which writes the clusters) and gsc_sync_flow, e.g. on a schedule of its own.

The run log says where the documents go (rag-api's URL and the collection), what was read (rows, pages, queries,
clusters, what is left out), what was built, and each document as it is sent or deleted (app/seo_intel.sync).
"""

from __future__ import annotations

import logging
from typing import Any, ClassVar

from crewai.flow import listen, persist, start
from pydantic import PrivateAttr

from .. import seo_intel
from ..narrate import count
from ..runs import INSTANCE_ONLY
from ..state import SeoIntelSyncState
from .base import SeoFlow

log = logging.getLogger("seo_agent.flows.seo_intel")

PERFORMANCE_ROWS = 20_000  # page × query rows read for one run (a size guard, not a choice of what to send)


@persist(INSTANCE_ONLY)
class SeoIntelSyncFlow(SeoFlow[SeoIntelSyncState]):
    FLOW: ClassVar[str] = "seo_intel_sync_flow"
    _docs: list[Any] = PrivateAttr(default_factory=list)  # collect → ingest; not in the persisted state (can be large)

    @start()
    async def collect(self) -> None:
        async with self.step("collect") as rec:
            s, extra = self.state, self.deps.extra
            rag = extra.get("rag")
            if rag is None:
                s.outcome = "not_configured"
                rec.detail["reason"] = "RAG_API_URL or RAG_BEARER_TOKEN is not set"
                log.info(
                    "moks-rag is not configured (RAG_API_URL or RAG_BEARER_TOKEN is not set): nothing to send", extra={"event": "seo_intel_not_configured"}
                )
                return
            ml = extra["ml_store"]
            site = self.deps.settings.site_url
            target = {"rag_api_url": rag.base_url, "collection": rag.seo_collection}
            log.info(
                f"Destination: moks-rag at {rag.base_url}, collection {rag.seo_collection}" + (" (full run: every document is sent again)" if s.full else ""),
                extra={"event": "seo_intel_destination", **target, "full": s.full},
            )
            days = seo_intel.GSC_DAYS
            log.info(
                f"Reading Search Console: page × query totals of the last {days} days, web search (seo_gsc_query_daily, at most {PERFORMANCE_ROWS:,} rows)",
                extra={"event": "seo_intel_read", "source": "search_console"},
            )
            performance = await ml.query_performance(days, PERFORMANCE_ROWS)
            log.info(
                "Reading keyword clusters: seo_ml_query_clusters (written by seo_ml_flow's query_clusters model)",
                extra={"event": "seo_intel_read", "source": "keyword_clusters"},
            )
            clusters = await ml.query_clusters()
            n = seo_intel.source_summary(clusters, performance, site)
            log.info(
                f"Search Console: {count(n['performance_rows'], 'page × query row')}: {count(n['pages'], 'page')}, {count(n['queries'], 'query', 'queries')}, {count(n['impressions'], 'impression')}, {count(n['clicks'], 'click')}",
                extra={
                    "event": "seo_intel_source",
                    "source": "search_console",
                    **{k: n[k] for k in ("performance_rows", "pages", "queries", "impressions", "clicks")},
                },
            )
            if len(performance) >= PERFORMANCE_ROWS:
                log.warning(
                    f"Reached the {PERFORMANCE_ROWS:,}-row limit: page × query rows with fewer impressions than these are left out",
                    extra={"event": "seo_intel_rows_capped", "limit": PERFORMANCE_ROWS},
                )
            if n["cluster_rows"]:
                log.info(
                    f"Keyword clusters: {count(n['cluster_rows'], 'query', 'queries')} in {count(n['clusters'], 'cluster')}",
                    extra={"event": "seo_intel_source", "source": "keyword_clusters", "cluster_rows": n["cluster_rows"], "clusters": n["clusters"]},
                )
            else:
                log.info(
                    "Keyword clusters: none yet (seo_ml_flow's query_clusters model writes them), so no keyword_cluster documents",
                    extra={"event": "seo_intel_source", "source": "keyword_clusters", "cluster_rows": 0, "clusters": 0},
                )
            if n["queries_left_out"]:
                log.info(
                    f"Left out {count(n['queries_left_out'], 'query', 'queries')} that look{'s' if n['queries_left_out'] == 1 else ''} like an e-mail address, a phone number or a secret",
                    extra={"event": "seo_intel_left_out", "queries": n["queries_left_out"]},
                )
            if n["rows_other_sites"]:
                log.info(
                    f"Left out {count(n['rows_other_sites'], 'row')} for pages that are not on {site}",
                    extra={"event": "seo_intel_left_out", "rows": n["rows_other_sites"]},
                )
            clusters_docs = seo_intel.cluster_docs(clusters, performance, site)
            pages_docs = seo_intel.page_docs(performance, site)
            docs = clusters_docs + pages_docs
            self._docs = docs
            log.info(
                f"Built {count(len(docs), 'document')}: {len(clusters_docs):,} keyword_cluster (one per cluster), {len(pages_docs):,} gsc_performance (one per page of the site)",
                extra={"event": "seo_intel_built", "documents": len(docs), "keyword_cluster": len(clusters_docs), "gsc_performance": len(pages_docs)},
            )
            s.result = {"performance_rows": len(performance), "cluster_rows": len(clusters), "documents": len(docs), **target}
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
