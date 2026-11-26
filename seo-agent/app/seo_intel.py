"""seo_intel: the agent's own collection in the shared moks-rag service (app/moks_rag.py).

What goes in, one document per row below. Every chunk carries `type`, `target_keyword` and `updated_at` (when the
document's content last changed, ISO 8601 UTC) in its metadata, so a query can filter on them (rag-api filters are
exact matches on metadata).

| type             | doc_id                         | from                                                              |
|------------------|--------------------------------|-------------------------------------------------------------------|
| keyword_cluster  | keyword_cluster:<label slug>   | seo_ml_query_clusters (seo_ml_flow) + Search Console, 28 days       |
| gsc_performance  | gsc_performance:<path slug>    | Search Console, 28 days: one page and the queries it ranks for      |
| competitor_brief | competitor_brief:<slug>        | an admin: POST /seo-intel/documents                               |
| style_guide      | style_guide:<slug>             | brand and style guidelines, the same way; style_guide:site is the |
|                  |                                | site's own guide, taken from the brief of each new article run    |

The first two are rebuilt from the database by seo_intel_sync_flow (app/flows/seo_intel.py): a document whose content
did not change is not sent again, and one that no longer exists (a cluster gone after a retrain, a page without
impressions) is deleted from seo_intel. The other two are never touched by the sync.

What the agent sent is recorded in seo_agent_rag_documents (created at start-up, owned by the agent): rag-api has no
way to list or read a document, and the content hash there is what lets the sync skip unchanged ones.

Search Console queries are user input: a query that looks like an e-mail address, a phone number or a secret is left
out (tools.safe_queries), as it is for the crews. seo_intel is readable by every holder of rag-api's shared token and
through Open WebUI's moks-seo-agent model.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal, Protocol
from urllib.parse import urlsplit

from .moks_rag import RagClient, RagError
from .tools import redact, safe_queries

log = logging.getLogger("seo_agent.seo_intel")

DocType = Literal["keyword_cluster", "gsc_performance", "competitor_brief", "style_guide"]
DOC_TYPES: tuple[DocType, ...] = ("keyword_cluster", "gsc_performance", "competitor_brief", "style_guide")
SYNCED_TYPES: tuple[DocType, ...] = ("keyword_cluster", "gsc_performance")  # rebuilt by seo_intel_sync_flow
UPLOADED_TYPES: tuple[DocType, ...] = ("competitor_brief", "style_guide")  # sent by an admin (or the brief)
GSC_DAYS = 28  # the same window the crews' Search Console tools use (tools.py)
SITE_STYLE_GUIDE_ID = "style_guide:site"


def slug(text: str, limit: int = 120) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s[:limit].rstrip("-") or "untitled"


@dataclass(frozen=True)
class IntelDoc:
    doc_id: str
    type: DocType
    title: str
    text: str
    target_keyword: str = ""
    source: str = ""
    extra: dict[str, str | int | float | bool] = field(default_factory=dict)  # more metadata (page, queries)

    @property
    def content_hash(self) -> str:
        """Of everything that is sent except updated_at, so an unchanged document hashes the same on every run."""
        raw = json.dumps([self.type, self.title, self.text, self.target_keyword, self.source, sorted(self.extra.items())], ensure_ascii=False)
        return hashlib.sha256(raw.encode()).hexdigest()

    def metadata(self, updated_at: datetime) -> dict[str, Any]:
        return {**self.extra, "type": self.type, "target_keyword": self.target_keyword, "updated_at": updated_at.astimezone(UTC).isoformat(timespec="seconds")}


# --- documents built from the database -----------------------------------------------------------------------------


@dataclass
class _Perf:
    clicks: float = 0.0
    impressions: float = 0.0
    pos_weighted: float = 0.0  # Σ position × impressions, over rows that have a position
    pos_impressions: float = 0.0
    pages: dict[str, float] = field(default_factory=dict)  # page → impressions

    def add(self, r: dict[str, Any]) -> None:
        impressions = float(r.get("impressions") or 0)
        self.clicks += float(r.get("clicks") or 0)
        self.impressions += impressions
        if r.get("position") is not None:
            self.pos_weighted += float(r["position"]) * impressions
            self.pos_impressions += impressions
        page = str(r.get("page") or "")
        if page:
            self.pages[page] = self.pages.get(page, 0.0) + impressions

    def numbers(self) -> str:
        ctr = f"{self.clicks / self.impressions * 100:.1f}%" if self.impressions else "n/a"
        pos = f"{self.pos_weighted / self.pos_impressions:.1f}" if self.pos_impressions else "n/a"
        return f"{int(self.impressions):,} impressions, {int(self.clicks):,} clicks, CTR {ctr}, average position {pos}"

    def top_page(self) -> str:
        return max(self.pages.items(), key=lambda kv: kv[1])[0] if self.pages else ""


def site_path(page: str, site_url: str) -> str | None:
    """The path of one of this site's pages (absolute URL on the site's host, or a path), else None."""
    page = page.strip()
    if page.startswith("/") and not page.startswith("//"):
        return page.split("#", 1)[0] or "/"
    parts = urlsplit(page)
    if parts.scheme not in ("http", "https"):
        return None
    if _host(parts.hostname or "") != _host(urlsplit(site_url).hostname or ""):
        return None
    return parts.path or "/"


def _host(h: str) -> str:
    h = h.lower().rstrip(".")
    return h[4:] if h.startswith("www.") else h


def _clean(rows: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rows whose query is safe to share (no e-mail address, phone number or secret)."""
    rows = list(rows)
    keep = set(safe_queries([str(r.get("query") or "") for r in rows]))
    return [r for r in rows if str(r.get("query") or "") in keep and str(r.get("query") or "").strip()]


def cluster_docs(clusters: list[dict[str, Any]], performance: list[dict[str, Any]], site_url: str, days: int = GSC_DAYS) -> list[IntelDoc]:
    """One keyword_cluster document per query cluster: its queries by impressions, with their numbers.
    `clusters`: seo_ml_query_clusters rows (query, cluster_id, cluster_label); `performance`: page × query rows."""
    by_query: dict[str, _Perf] = defaultdict(_Perf)
    for r in _clean(performance):
        by_query[str(r["query"])].add(r)
    groups: dict[str, list[str]] = defaultdict(list)
    labels: dict[str, str] = {}
    for r in _clean(clusters):
        cid = str(r.get("cluster_id"))
        groups[cid].append(str(r["query"]))
        labels.setdefault(cid, str(r.get("cluster_label") or r["query"]))
    docs: list[IntelDoc] = []
    seen: set[str] = set()
    for cid, queries in groups.items():
        label = labels[cid]
        if not safe_queries([label]):
            label = max(queries, key=lambda q: by_query[q].impressions)  # the label was a query that is not shared
        queries = sorted(set(queries), key=lambda q: (-by_query[q].impressions, q))
        total = _Perf()
        for q in queries:
            p = by_query[q]
            total.clicks += p.clicks
            total.impressions += p.impressions
            total.pos_weighted += p.pos_weighted
            total.pos_impressions += p.pos_impressions
        lines = [
            f"Keyword cluster “{label}”: {len(queries)} search queries that mean the same thing (seo_ml query clusters).",
            f"Google Search Console, web search, last {days} days, all queries together: {total.numbers()}.",
            "Queries, most impressions first:",
        ]
        for q in queries:
            p = by_query[q]
            page = site_path(p.top_page(), site_url) if p.top_page() else None
            lines.append(f"- {q}: {p.numbers() if p.impressions else 'no impressions in the window'}" + (f"; ranks best with {page}" if page else ""))
        doc_id = f"keyword_cluster:{slug(label)}"
        if doc_id in seen:
            doc_id = f"{doc_id}-{slug(cid, 20)}"
        seen.add(doc_id)
        docs.append(IntelDoc(doc_id, "keyword_cluster", f"Keyword cluster: {label}", redact("\n".join(lines)), target_keyword=label, source="seo_ml_query_clusters", extra={"queries": len(queries)}))
    return docs


def page_docs(performance: list[dict[str, Any]], site_url: str, days: int = GSC_DAYS) -> list[IntelDoc]:
    """One gsc_performance document per page of this site: the queries it ranks for, with their numbers."""
    pages: dict[str, dict[str, _Perf]] = defaultdict(lambda: defaultdict(_Perf))
    for r in _clean(performance):
        path = site_path(str(r.get("page") or ""), site_url)
        if path is not None:
            pages[path][str(r["query"])].add(r)
    docs: list[IntelDoc] = []
    seen: set[str] = set()
    base = site_url.rstrip("/")
    for path, queries in sorted(pages.items()):
        # No "/" in a doc_id: rag-api's DELETE /documents/{doc_id} cannot route one, even percent-encoded.
        doc_id = f"gsc_performance:{slug(path, 200) if path != '/' else 'home'}"
        if doc_id in seen:
            doc_id = f"{doc_id}-{hashlib.sha1(path.encode()).hexdigest()[:8]}"  # noqa: S324 - a name, not security
        seen.add(doc_id)
        ranked = sorted(queries.items(), key=lambda kv: (-kv[1].impressions, kv[0]))
        total = _Perf()
        for _, p in ranked:
            total.clicks += p.clicks
            total.impressions += p.impressions
            total.pos_weighted += p.pos_weighted
            total.pos_impressions += p.pos_impressions
        lines = [
            f"Search performance of {base}{path} (Google Search Console, web search, last {days} days).",
            f"All queries together: {total.numbers()}.",
            "Queries this page ranks for, most impressions first:",
            *(f"- {q}: {p.numbers()}" for q, p in ranked),
        ]
        top = ranked[0][0] if ranked else ""
        docs.append(IntelDoc(doc_id, "gsc_performance", f"Search Console: {path}", redact("\n".join(lines)), target_keyword=top, source=f"{base}{path}", extra={"page": path, "queries": len(ranked)}))
    return docs


def uploaded_doc(type_: str, title: str, text: str, *, doc_id: str | None = None, target_keyword: str = "", source: str = "") -> IntelDoc:
    """A competitor brief or a brand/style guideline sent by an admin. The doc_id is `<type>:<slug>`; sending the same
    one again replaces the document."""
    if type_ not in UPLOADED_TYPES:
        raise ValueError(f"type must be one of {', '.join(UPLOADED_TYPES)} ({', '.join(SYNCED_TYPES)} are rebuilt by seo_intel_sync_flow)")
    if not title.strip() or not text.strip():
        raise ValueError("title and text are required")
    key = slug(doc_id.split(":", 1)[-1] if doc_id else title)
    return IntelDoc(f"{type_}:{key}", type_, " ".join(title.split())[:300], redact(text.strip()), target_keyword=" ".join(target_keyword.split())[:200], source=source.strip()[:500])


def site_style_guide_doc(text: str, site_url: str) -> IntelDoc:
    return IntelDoc(SITE_STYLE_GUIDE_ID, "style_guide", "Site style guide", text.strip(), source=site_url)


# --- what the agent sent: seo_agent_rag_documents ------------------------------------------------------------------


class RagDocStore(Protocol):
    async def ensure_schema(self) -> None: ...
    async def hashes(self, collection: str, types: Iterable[str]) -> dict[str, str]: ...
    async def save(self, collection: str, doc: IntelDoc, chunks: int) -> None: ...
    async def remove(self, collection: str, doc_id: str) -> None: ...
    async def list(self, collection: str, type_: str | None = None, limit: int = 200) -> list[dict[str, Any]]: ...


SCHEMA = """create table if not exists seo_agent_rag_documents (
  collection text not null,
  doc_id text not null,
  type text not null,
  title text not null default '',
  target_keyword text not null default '',
  content_hash text not null,
  chunks integer not null default 0,
  ingested_at timestamptz not null default now(),
  primary key (collection, doc_id)
)"""


class PgRagDocStore:
    def __init__(self, pool: Any):
        self.pool = pool

    async def ensure_schema(self) -> None:
        async with self.pool.connection() as c:
            await c.execute(SCHEMA)

    async def hashes(self, collection: str, types: Iterable[str]) -> dict[str, str]:
        async with self.pool.connection() as c:
            cur = await c.execute("select doc_id, content_hash from seo_agent_rag_documents where collection = %s and type = any(%s)", (collection, list(types)))
            return {r["doc_id"]: r["content_hash"] for r in await cur.fetchall()}

    async def save(self, collection: str, doc: IntelDoc, chunks: int) -> None:
        async with self.pool.connection() as c:
            await c.execute(
                """insert into seo_agent_rag_documents (collection, doc_id, type, title, target_keyword, content_hash, chunks, ingested_at)
                   values (%s, %s, %s, %s, %s, %s, %s, now())
                   on conflict (collection, doc_id) do update set type = excluded.type, title = excluded.title, target_keyword = excluded.target_keyword,
                     content_hash = excluded.content_hash, chunks = excluded.chunks, ingested_at = excluded.ingested_at""",
                (collection, doc.doc_id, doc.type, doc.title, doc.target_keyword, doc.content_hash, chunks),
            )

    async def remove(self, collection: str, doc_id: str) -> None:
        async with self.pool.connection() as c:
            await c.execute("delete from seo_agent_rag_documents where collection = %s and doc_id = %s", (collection, doc_id))

    async def list(self, collection: str, type_: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
        async with self.pool.connection() as c:
            cur = await c.execute(
                """select doc_id, type, title, target_keyword, chunks, ingested_at from seo_agent_rag_documents
                   where collection = %s and (%s::text is null or type = %s) order by type, doc_id limit %s""",
                (collection, type_, type_, max(1, min(1000, limit))),
            )
            return [dict(r) for r in await cur.fetchall()]


@dataclass
class MemoryRagDocStore:
    rows: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)

    async def ensure_schema(self) -> None:
        return None

    async def hashes(self, collection: str, types: Iterable[str]) -> dict[str, str]:
        want = set(types)
        return {d: r["content_hash"] for (c, d), r in self.rows.items() if c == collection and r["type"] in want}

    async def save(self, collection: str, doc: IntelDoc, chunks: int) -> None:
        self.rows[(collection, doc.doc_id)] = {"doc_id": doc.doc_id, "type": doc.type, "title": doc.title, "target_keyword": doc.target_keyword, "content_hash": doc.content_hash, "chunks": chunks, "ingested_at": datetime.now(UTC)}

    async def remove(self, collection: str, doc_id: str) -> None:
        self.rows.pop((collection, doc_id), None)

    async def list(self, collection: str, type_: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
        out = [{k: v for k, v in r.items() if k != "content_hash"} for (c, _), r in sorted(self.rows.items()) if c == collection and (type_ is None or r["type"] == type_)]
        return sorted(out, key=lambda r: (r["type"], r["doc_id"]))[:limit]


# --- ingest --------------------------------------------------------------------------------------------------------


async def put(rag: RagClient, store: RagDocStore, doc: IntelDoc, *, now: datetime | None = None) -> dict[str, Any]:
    """Ingest one document (replacing an earlier version) and record it."""
    r = await rag.ingest(doc_id=doc.doc_id, text=doc.text, title=doc.title, source=doc.source or None, metadata=doc.metadata(now or datetime.now(UTC)))
    chunks = int(r.get("chunks_ingested") or 0)
    await store.save(rag.seo_collection, doc, chunks)
    return {"doc_id": doc.doc_id, "type": doc.type, "chunks": chunks}


async def put_if_changed(rag: RagClient, store: RagDocStore, doc: IntelDoc) -> bool:
    """Ingest the document unless the same content is already there. True when it was sent."""
    known = await store.hashes(rag.seo_collection, [doc.type])
    if known.get(doc.doc_id) == doc.content_hash:
        return False
    await put(rag, store, doc)
    return True


async def remove(rag: RagClient, store: RagDocStore, doc_id: str) -> None:
    await rag.delete_document(doc_id)
    await store.remove(rag.seo_collection, doc_id)


async def sync(rag: RagClient, store: RagDocStore, docs: list[IntelDoc], *, types: tuple[str, ...] = SYNCED_TYPES, full: bool = False) -> dict[str, Any]:
    """Make seo_intel hold exactly `docs` for `types`: send new and changed documents (all of them when `full`),
    delete the ones that are gone. Stops at the first request that fails after its retries (rag-api down, token
    refused): what was sent before it is recorded, so the next run carries on from there."""
    if any(d.type not in types for d in docs):
        raise ValueError("a document's type is not one of the synced types")
    known = await store.hashes(rag.seo_collection, types)
    wanted = {d.doc_id: d for d in docs}
    out: dict[str, Any] = {"documents": len(wanted), "ingested": 0, "unchanged": 0, "deleted": 0, "chunks": 0, "by_type": {t: sum(1 for d in wanted.values() if d.type == t) for t in types}}
    now = datetime.now(UTC)
    try:
        for d in wanted.values():
            if not full and known.get(d.doc_id) == d.content_hash:
                out["unchanged"] += 1
                continue
            r = await put(rag, store, d, now=now)
            out["ingested"] += 1
            out["chunks"] += r["chunks"]
        for doc_id in sorted(set(known) - set(wanted)):
            await remove(rag, store, doc_id)
            out["deleted"] += 1
    except RagError as e:
        out["error"] = str(e)[:300]
        log.warning("seo_intel sync stopped", extra={"event": "seo_intel_sync_stopped", "status": e.status, **{k: v for k, v in out.items() if isinstance(v, int)}})
        raise SyncStopped(out) from e
    log.info("seo_intel synced", extra={"event": "seo_intel_synced", **{k: v for k, v in out.items() if isinstance(v, int)}})
    return out


class SyncStopped(Exception):
    def __init__(self, result: dict[str, Any]):
        super().__init__(result.get("error") or "seo_intel sync stopped")
        self.result = result
