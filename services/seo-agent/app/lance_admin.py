"""LanceDB browser for the admin (D-92): list tables, page through rows, edit or delete one row at a time.

LanceDB is embedded: there is no server, only files. They live on Cloudflare R2 under `jithendar/seo-agent/lancedb/`
in the media bucket, with the keys from Admin → Storage, which the web app hands over on its internal port (D-91:
GET /internal/seo-agent/storage/lancedb). LANCEDB_URI overrides that with a folder, for local development. seo-agent
owns the storage, so the web app's /admin/lancedb page reaches it through this service's internal API (bearer
SEO_AGENT_TOKEN, ClusterIP only).

Edits are deliberately narrow:
- one row per request, picked by a key column and value that must match exactly one row (409 otherwise), so a request
  can never change or delete many rows at once;
- only scalar columns (strings, numbers, booleans, timestamps as ISO text) can be edited; vectors and nested columns
  are shown abridged and are read-only, because a hand-edited embedding is never right;
- names (tables, columns) must be plain identifiers and must exist; values become SQL literals only through `_literal`.
Every write is a new table version, which LanceDB keeps, and is logged with the admin who made it.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import math
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger(__name__)

IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
MAX_PAGE = 100
VECTOR_PREVIEW = 8  # leading values shown for a vector cell
TEXT_PREVIEW = 300  # characters of a string cell in the page view (the row view returns the whole value)


class LanceError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


@dataclass
class Column:
    name: str
    type: str
    kind: str
    editable: bool
    nullable: bool


def _kind(t: Any) -> str:
    import pyarrow as pa

    if pa.types.is_string(t) or pa.types.is_large_string(t):
        return "string"
    if pa.types.is_boolean(t):
        return "bool"
    if pa.types.is_integer(t):
        return "int"
    if pa.types.is_floating(t):
        return "float"
    if pa.types.is_timestamp(t) or pa.types.is_date(t):
        return "timestamp"
    if pa.types.is_fixed_size_list(t) or pa.types.is_list(t) or pa.types.is_large_list(t):
        return "vector" if pa.types.is_floating(t.value_type) else "list"
    return "other"


def columns_of(schema: Any) -> list[Column]:
    out = []
    for f in schema:
        k = _kind(f.type)
        out.append(Column(f.name, str(f.type), k, k in ("string", "bool", "int", "float", "timestamp") and bool(IDENT.match(f.name)), f.nullable))
    return out


def _literal(value: Any, kind: str) -> str:
    """A value as a SQL literal for LanceDB's filter language (DataFusion). Never interpolates anything else."""
    if value is None:
        return "NULL"
    if kind == "bool":
        if isinstance(value, bool):
            return "true" if value else "false"
        raise LanceError("expected true or false")
    if kind == "int":
        if isinstance(value, bool) or not isinstance(value, int):
            if isinstance(value, str) and re.fullmatch(r"-?\d{1,19}", value.strip()):
                return str(int(value))
            raise LanceError("expected an integer")
        return str(int(value))
    if kind == "float":
        try:
            f = float(value)
        except (TypeError, ValueError):
            raise LanceError("expected a number") from None
        if not math.isfinite(f):
            raise LanceError("expected a finite number")
        return repr(f)
    if kind == "timestamp":
        try:
            ts = dt.datetime.fromisoformat(str(value))
        except ValueError:
            raise LanceError("expected an ISO 8601 timestamp") from None
        return f"timestamp '{ts.isoformat(sep=' ')}'"
    if kind == "string":
        s = str(value)
        if "\x00" in s:
            raise LanceError("text may not contain NUL")
        return "'" + s.replace("'", "''") + "'"
    raise LanceError("this column cannot be used here")


def _coerce(value: Any, kind: str) -> Any:
    """The Python value LanceDB's update(values=...) is given (checked with the same rules as _literal)."""
    if value is None:
        return None
    _literal(value, kind)
    if kind == "int":
        return int(value)
    if kind == "float":
        return float(value)
    if kind == "timestamp":
        return dt.datetime.fromisoformat(str(value))
    if kind == "string":
        return str(value)
    return value


def _cell(v: Any, kind: str, full: bool) -> Any:
    if v is None:
        return None
    if kind == "vector":
        return {"dims": len(v), "head": [round(float(x), 5) for x in v[:VECTOR_PREVIEW]]}
    if kind == "list":
        return {"items": len(v), "head": [str(x)[:60] for x in v[:VECTOR_PREVIEW]]}
    if isinstance(v, (dt.datetime, dt.date)):
        return v.isoformat()
    if isinstance(v, bytes):
        return f"<{len(v)} bytes>"
    if isinstance(v, str) and not full and len(v) > TEXT_PREVIEW:
        return {"text": v[:TEXT_PREVIEW], "length": len(v)}
    if isinstance(v, float) and not math.isfinite(v):
        return str(v)
    if isinstance(v, (dict, list)):
        return str(v)[:TEXT_PREVIEW]
    return v


RETRY_S = 60.0  # how long "storage is not set up" is believed before asking the web app again


@dataclass
class LanceAdmin:
    uri: str = ""
    storage_options: dict[str, str] = field(default_factory=dict)
    # Asks the web app for the R2 connection (webapp.lancedb_storage). Not used when `uri` is set.
    resolve: Callable[[], Awaitable[dict[str, Any]]] | None = None
    source: str | None = None  # "env" (LANCEDB_URI) or "storage" (Admin → Storage)
    _db: Any = None
    _asked_at: float = -RETRY_S

    async def ensure(self) -> None:
        """Connect to the storage Admin → Storage describes, once it exists (checked again at most once a minute)."""
        if self.uri or self.resolve is None or time.monotonic() - self._asked_at < RETRY_S:
            return
        self._asked_at = time.monotonic()
        try:
            cfg = await self.resolve()
        except Exception as e:  # the web app is down or refuses: stay unconfigured, say why in the log
            log.warning("lancedb storage unavailable", extra={"event": "lancedb_storage_unavailable", "error": type(e).__name__})
            return
        if not cfg.get("configured") or not str(cfg.get("uri", "")).startswith("s3://"):
            return
        self.uri = str(cfg["uri"])
        opts = {"endpoint": cfg.get("endpoint"), "aws_access_key_id": cfg.get("accessKeyId"), "aws_secret_access_key": cfg.get("secretAccessKey"), "region": cfg.get("region") or "auto"}
        self.storage_options = {k: str(v) for k, v in opts.items() if v}
        self.source = "storage"
        self._db = None

    @property
    def configured(self) -> bool:
        return bool(self.uri)

    def location(self) -> str:
        """Where the data is, safe to show: the URI only (credentials are never part of it)."""
        return re.sub(r"//[^/@]*@", "//", self.uri)

    def _conn(self) -> Any:
        if not self.configured:
            raise LanceError("LanceDB is not configured (LANCEDB_URI).", 503)
        if self._db is None:
            import lancedb

            self._db = lancedb.connect(self.uri, storage_options=self.storage_options or None)
        return self._db

    def _names(self) -> list[str]:
        db = self._conn()
        names: list[str] = []
        token = None
        while True:
            page = db.list_tables(page_token=token) if token else db.list_tables()
            names.extend(page.tables)
            token = page.page_token
            if not token:
                return sorted(names)

    def _table(self, name: str) -> Any:
        if not IDENT.match(name) or name not in self._names():
            raise LanceError("table not found", 404)
        return self._conn().open_table(name)

    @staticmethod
    def _column(cols: list[Column], name: str, *, editable: bool) -> Column:
        col = next((c for c in cols if c.name == name), None)
        if col is None or not IDENT.match(name):
            raise LanceError(f"unknown column: {name[:64]}")
        if editable and not col.editable:
            raise LanceError(f"column {name} is read-only (vectors and nested values cannot be edited)")
        return col

    # --- reads -----------------------------------------------------------------------------------------------------

    def overview(self) -> dict[str, Any]:
        if not self.configured:
            return {"configured": False, "location": None, "source": None, "tables": []}
        tables = []
        for n in self._names():
            t = self._conn().open_table(n)
            tables.append({"name": n, "rows": t.count_rows(), "version": t.version, "columns": [c.__dict__ for c in columns_of(t.schema)]})
        return {"configured": True, "location": self.location(), "source": self.source, "tables": tables}

    def browse(self, name: str, offset: int = 0, limit: int = 25) -> dict[str, Any]:
        t = self._table(name)
        cols = columns_of(t.schema)
        limit = max(1, min(MAX_PAGE, limit))
        offset = max(0, offset)
        kinds = {c.name: c.kind for c in cols}
        rows = t.search().offset(offset).limit(limit).to_list() if t.count_rows() else []
        return {
            "table": name,
            "version": t.version,
            "total": t.count_rows(),
            "offset": offset,
            "limit": limit,
            "columns": [c.__dict__ for c in cols],
            "rows": [{k: _cell(r.get(k), kinds[k], full=False) for k in kinds} for r in rows],
        }

    def row(self, name: str, key_column: str, key: Any) -> dict[str, Any]:
        t = self._table(name)
        cols = columns_of(t.schema)
        where = self._where(cols, key_column, key)
        found = t.search().where(where).limit(2).to_list()
        if len(found) != 1:
            raise LanceError("no single row matches that key" if found else "row not found", 409 if found else 404)
        kinds = {c.name: c.kind for c in cols}
        return {"table": name, "columns": [c.__dict__ for c in cols], "row": {k: _cell(found[0].get(k), kinds[k], full=True) for k in kinds}}

    # --- writes ----------------------------------------------------------------------------------------------------

    def _where(self, cols: list[Column], key_column: str, key: Any) -> str:
        col = self._column(cols, key_column, editable=True)  # a key must be a plain scalar column
        if key is None:
            raise LanceError("a key value is required")
        return f"{col.name} = {_literal(key, col.kind)}"

    def _one(self, t: Any, where: str) -> None:
        n = t.count_rows(where)
        if n != 1:
            raise LanceError("row not found" if n == 0 else f"the key matches {n} rows; pick a unique key column", 404 if n == 0 else 409)

    def update(self, name: str, key_column: str, key: Any, values: dict[str, Any], actor: str | None = None) -> dict[str, Any]:
        if not values:
            raise LanceError("nothing to change")
        t = self._table(name)
        cols = columns_of(t.schema)
        where = self._where(cols, key_column, key)
        self._one(t, where)
        new: dict[str, Any] = {}
        for k, v in values.items():
            col = self._column(cols, k, editable=True)
            if v is None and not col.nullable:
                raise LanceError(f"column {k} cannot be empty")
            new[k] = _coerce(v, col.kind)
        t.update(where=where, values=new)
        log.info("lancedb row updated", extra={"event": "lancedb_update", "table": name, "key_column": key_column, "columns": sorted(new), "version": t.version, "actor": actor})
        return {"updated": 1, "version": t.version}

    def delete(self, name: str, key_column: str, key: Any, actor: str | None = None) -> dict[str, Any]:
        t = self._table(name)
        where = self._where(columns_of(t.schema), key_column, key)
        self._one(t, where)
        t.delete(where)
        log.info("lancedb row deleted", extra={"event": "lancedb_delete", "table": name, "key_column": key_column, "version": t.version, "actor": actor})
        return {"deleted": 1, "version": t.version}

    # --- async wrappers (LanceDB's Python API is blocking) -----------------------------------------------------------

    async def run(self, fn: str, *args: Any, **kw: Any) -> Any:
        await self.ensure()
        return await asyncio.to_thread(getattr(self, fn), *args, **kw)


def from_env(env: dict[str, str], resolve: Callable[[], Awaitable[dict[str, Any]]] | None = None) -> LanceAdmin:
    """LANCEDB_URI (a folder; local development) wins; otherwise the R2 connection from Admin → Storage via `resolve`."""
    uri = env.get("LANCEDB_URI", "").strip()
    return LanceAdmin(uri, resolve=None if uri else resolve, source="env" if uri else None)
