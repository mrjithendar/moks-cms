"""Client for the shared moks-rag service (mrjithendar/moks-rag, namespace rag): hybrid retrieval over Qdrant.

The agent owns one collection, `seo_intel` (RAG_SEO_COLLECTION: keyword clusters, Search Console performance,
competitor briefs, brand and style guidelines; app/seo_intel.py), and reads the web app's articles from `cms_content`
(RAG_CMS_COLLECTION) for internal links, the cannibalization check and grounding (app/site_context.py). Off unless
RAG_API_URL and RAG_BEARER_TOKEN are both set (Settings.rag_enabled).

The contract (moks-rag/app/src/rag_api/main.py and models.py):
- POST /ingest {collection, doc_id, text, title, source, metadata} → {doc_id, collection, chunks_ingested}. rag-api
  deletes a doc_id's chunks before it upserts the new ones, so ingesting the same doc_id again replaces it, and a
  retried ingest cannot duplicate anything. This client always sends a doc_id for that reason.
- DELETE /documents/{doc_id}?collection=… → {deleted}. rag-api's default collection is "all" (every service's
  collections): this client always names one. rag-api has no GET for a document.
- POST /query {collection, query, top_k, filters, include_answer} → {sources: [{id, doc_id, score, text, metadata}]}.
  `include_answer` is always false here: rag-api's answer is a Claude call through its own LiteLLM key, outside the
  agent's one LLM budget (app/llm_budgets.py). The agent's crews write with the agent's own metered client.
  `score` is a Reciprocal Rank Fusion score: it orders one answer's sources and says nothing about how similar a
  passage is, so nothing here compares it with a fixed number.
- Every request: Authorization: Bearer <RAG_BEARER_TOKEN>, X-Service-Name: moks-seo-agent, and an X-Request-ID that
  stays the same across retries (rag-api logs it with each request).

The bearer token is shared by every caller of rag-api and opens every collection; X-Service-Name only labels rag-api's
logs. So this client refuses, before sending anything, a write (ingest, delete) to any collection but the agent's own,
and a query of any collection but the two it is configured with.

Retries: connection errors, timeouts, 408/425/429 and 5xx, with exponential backoff (a Retry-After of up to 30 s
replaces the backoff). Anything else (401, 404, 422) raises at once. One JSON log line per request, after its
retries: operation, collection, status, attempts, duration and request id, never the token, the text or the query.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import httpx

from . import metrics, tracing
from .runs import CURRENT_RUN_ID

log = logging.getLogger("seo_agent.moks_rag")

SERVICE_NAME = "moks-seo-agent"
TRANSIENT_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})
MAX_RETRY_AFTER_S = 30.0
MAX_TEXT_CHARS = 400_000  # one document; rag-api chunks it (1,500 characters each by default)
MAX_QUERY_CHARS = 4000
MAX_TOP_K = 50  # rag-api's own limit
DOC_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9:_.\-]{0,299}")


class RagError(Exception):
    """A request that did not succeed. `status` 0 = no HTTP answer (connection error, timeout)."""

    def __init__(self, status: int, message: str, *, op: str = "", request_id: str = ""):
        super().__init__(f"moks-rag {op or 'request'} failed: {status or 'no answer'} {message}".strip())
        self.status = status
        self.message = message
        self.op = op
        self.request_id = request_id

    @property
    def transient(self) -> bool:
        return self.status == 0 or self.status in TRANSIENT_STATUS


class RagWriteRefused(RagError):
    """A write to (or a query of) a collection this agent may not touch. Never sent."""

    def __init__(self, op: str, collection: str, allowed: tuple[str, ...]):
        super().__init__(0, f"collection {collection!r} is not one of {', '.join(allowed)}", op=op)
        self.collection = collection

    @property
    def transient(self) -> bool:
        return False


@dataclass(frozen=True)
class RagChunk:
    """One retrieved chunk. `metadata` is the Qdrant payload rag-api stored with it, without the text."""

    id: str
    doc_id: str
    score: float
    text: str
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class RagClient:
    base_url: str
    token: str
    seo_collection: str = "seo_intel"
    cms_collection: str = "cms_content"
    timeout_s: float = 120.0
    query_timeout_s: float = 20.0
    attempts: int = 3
    backoff_s: float = 1.0
    transport: httpx.AsyncBaseTransport | None = None
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep
    _client: httpx.AsyncClient | None = field(default=None, init=False, repr=False)

    def __post_init__(self) -> None:
        if not self.base_url or not self.token:
            raise ValueError("RagClient needs RAG_API_URL and RAG_BEARER_TOKEN")
        self.attempts = max(1, self.attempts)

    @classmethod
    def from_settings(cls, settings: Any, **kw: Any) -> RagClient | None:
        """The client for these settings, or None when moks-rag is not configured."""
        if not getattr(settings, "rag_enabled", False):
            return None
        return cls(
            settings.rag_api_url,
            settings.rag_bearer_token,
            seo_collection=settings.rag_seo_collection,
            cms_collection=settings.rag_cms_collection,
            timeout_s=settings.rag_timeout_s,
            query_timeout_s=settings.rag_query_timeout_s,
            **kw,
        )

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self.base_url.rstrip("/"),
                headers={"Authorization": f"Bearer {self.token}", "X-Service-Name": SERVICE_NAME, "User-Agent": f"{SERVICE_NAME}/1"},
                timeout=httpx.Timeout(self.timeout_s, connect=5.0),
                transport=self.transport,
                follow_redirects=False,  # the token must never follow a redirect to another host
            )
        return self._client

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # --- operations ------------------------------------------------------------------------------------------------

    async def ingest(self, *, doc_id: str, text: str, title: str | None = None, source: str | None = None, metadata: dict[str, Any] | None = None, collection: str | None = None) -> dict[str, Any]:
        """Index one document in the agent's own collection, replacing an earlier version with the same doc_id."""
        target = collection or self.seo_collection
        self._writable("ingest", target)
        if not DOC_ID.fullmatch(doc_id):
            raise ValueError("doc_id is required: letters, digits and : _ . - only, at most 300 (a repeated ingest replaces it; DELETE cannot route a '/')")
        if not text.strip():
            raise ValueError("text is empty")
        body: dict[str, Any] = {"collection": target, "doc_id": doc_id, "text": text[:MAX_TEXT_CHARS], "metadata": dict(metadata or {})}
        if title:
            body["title"] = title[:300]
        if source:
            body["source"] = source[:500]
        return await self._request("ingest", "POST", "/ingest", collection=target, doc_id=doc_id, json=body)

    async def delete_document(self, doc_id: str, *, collection: str | None = None) -> dict[str, Any]:
        """Remove one document's chunks from the agent's own collection (never from "all")."""
        target = collection or self.seo_collection
        self._writable("delete", target)
        if not DOC_ID.fullmatch(doc_id):
            raise ValueError("doc_id is required: letters, digits and : _ . - only, at most 300")
        return await self._request("delete", "DELETE", f"/documents/{_quote(doc_id)}", collection=target, doc_id=doc_id, params={"collection": target})

    async def query(self, collection: str, query: str, *, top_k: int = 5, filters: dict[str, str | int | float | bool] | None = None) -> list[RagChunk]:
        """Hybrid (dense + sparse, RRF) search of one collection. Sources only: rag-api's own answer is never asked for."""
        if collection not in (self.seo_collection, self.cms_collection):
            raise RagWriteRefused("query", collection, (self.seo_collection, self.cms_collection))
        q = " ".join(query.split())[:MAX_QUERY_CHARS]
        if not q:
            return []
        body: dict[str, Any] = {"collection": collection, "query": q, "top_k": max(1, min(MAX_TOP_K, int(top_k))), "include_answer": False}
        if filters:
            body["filters"] = filters
        data = await self._request("query", "POST", "/query", collection=collection, json=body, wait_s=self.query_timeout_s)
        return [_chunk(s) for s in (data.get("sources") or []) if isinstance(s, dict)]

    async def query_seo(self, query: str, *, top_k: int = 5, filters: dict[str, str | int | float | bool] | None = None) -> list[RagChunk]:
        return await self.query(self.seo_collection, query, top_k=top_k, filters=filters)

    async def query_cms(self, query: str, *, top_k: int = 5, filters: dict[str, str | int | float | bool] | None = None) -> list[RagChunk]:
        return await self.query(self.cms_collection, query, top_k=top_k, filters=filters)

    # --- transport -------------------------------------------------------------------------------------------------

    def _writable(self, op: str, collection: str) -> None:
        if collection != self.seo_collection:
            metrics.MOKS_RAG_REQUESTS.labels(op=op, outcome="refused").inc()
            log.warning("moks-rag write refused", extra={"event": "moks_rag_refused", "op": op, "collection": collection})
            raise RagWriteRefused(op, collection, (self.seo_collection,))

    async def _request(self, op: str, method: str, path: str, *, collection: str, doc_id: str | None = None, json: Any = None, params: dict[str, str] | None = None, wait_s: float | None = None) -> dict[str, Any]:
        request_id = uuid.uuid4().hex
        started = time.monotonic()
        status = 0
        data: Any = {}
        error: RagError | None = None
        attempt = 0
        with tracing.span(f"moks_rag.{op}", {"collection": collection, "request_id": request_id}):
            for attempt in range(1, self.attempts + 1):
                wait: float | None = None
                try:
                    headers = tracing.inject({"X-Request-ID": request_id})
                    kw: dict[str, Any] = {"headers": headers, "json": json, "params": params}
                    if wait_s is not None:
                        kw["timeout"] = httpx.Timeout(wait_s, connect=5.0)
                    r = await self.client.request(method, path, **kw)
                    status = r.status_code
                    if status < 400:
                        data = r.json() if r.content else {}
                        error = None
                        break
                    error = RagError(status, _detail(r), op=op, request_id=request_id)
                    wait = _retry_after(r)
                except httpx.HTTPError as e:  # connection refused, DNS, timeouts, protocol errors
                    status = 0
                    error = RagError(0, type(e).__name__, op=op, request_id=request_id)
                except ValueError:  # a 2xx whose body is not JSON
                    error = RagError(status, "the answer is not JSON", op=op, request_id=request_id)
                    break
                if not error.transient or attempt == self.attempts:
                    break
                delay = wait if wait is not None else self.backoff_s * (2 ** (attempt - 1))
                log.warning("moks-rag request retried", extra={"event": "moks_rag_retry", "op": op, "collection": collection, "status": status, "attempt": attempt, "delay_s": round(delay, 2), "request_id": request_id})
                await self.sleep(delay)
        seconds = time.monotonic() - started
        metrics.MOKS_RAG_SECONDS.labels(op=op).observe(seconds)
        metrics.MOKS_RAG_REQUESTS.labels(op=op, outcome="error" if error else "ok").inc()
        fields = {"event": "moks_rag_request", "op": op, "collection": collection, "status": status, "attempts": attempt, "duration_ms": round(seconds * 1000, 1), "request_id": request_id, "run_id": CURRENT_RUN_ID.get()}
        if doc_id:
            fields["doc_id"] = doc_id[:300]
        if error is not None:
            log.warning("moks-rag request failed", extra={**fields, "error": error.message[:300]})
            raise error
        if op == "ingest":
            fields["chunks"] = data.get("chunks_ingested")
        elif op == "query":
            fields["hits"] = len(data.get("sources") or [])
        log.info("moks-rag request", extra=fields)
        return data if isinstance(data, dict) else {}


def _quote(doc_id: str) -> str:
    from urllib.parse import quote

    return quote(doc_id, safe="")


def _chunk(s: dict[str, Any]) -> RagChunk:
    meta = s.get("metadata")
    try:
        score = float(s.get("score") or 0.0)
    except (TypeError, ValueError):
        score = 0.0
    return RagChunk(id=str(s.get("id") or ""), doc_id=str(s.get("doc_id") or ""), score=score, text=str(s.get("text") or ""), metadata=dict(meta) if isinstance(meta, dict) else {})


def _detail(r: httpx.Response) -> str:
    """FastAPI's {"detail": ...}, shortened; never the request (it holds the token in its headers)."""
    try:
        j = r.json()
    except ValueError:
        return r.reason_phrase or ""
    d = j.get("detail") if isinstance(j, dict) else None
    return str(d if d is not None else r.reason_phrase)[:300]


def _retry_after(r: httpx.Response) -> float | None:
    raw = r.headers.get("retry-after", "")
    try:
        v = float(raw)
    except ValueError:
        return None
    return v if 0 <= v <= MAX_RETRY_AFTER_S else None
