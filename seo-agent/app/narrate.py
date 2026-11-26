"""Wording for run log lines: the admin run page is read by a person, so a line says what happened in words.

Helpers only (no logging here): `count` ("1 document", "96 documents"), `facts` (a dict's plain values as
"documents 96, outcome synced"), `shape` (what an answer holds: "status succeeded, rows 1,234, items 12") and
`seconds` ("0.4 s", "2m 05s"). Values that may hold personal data or Search Console queries never go into a message:
messages also reach stderr → Loki. Put those in a line's `extra={"run_only": {...}}` (app/logs.RUN_ONLY) instead.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from typing import Any

# Field names whose string values are safe and useful in a message (identifiers and states, not content).
TEXT_FIELDS = frozenset({"status", "outcome", "code", "errorCode", "error_code", "reason", "kind", "type", "job", "model", "version", "window", "slot", "period", "trigger", "decision", "mode", "action"})
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_CAMEL = re.compile(r"([a-z0-9])([A-Z])")
_NAME = re.compile(r"^[a-z0-9][a-z0-9_.:-]{0,39}$")  # an identifier ("decay", "low_ctr"): shown; anything else is counted


def count(n: int, one: str, many: str | None = None) -> str:
    """A number and its noun: count(1, "document") → "1 document", count(1234, "query", "queries") → "1,234 queries"."""
    return f"{n:,} {one if n == 1 else (many or one + 's')}"


def label(key: str) -> str:
    """A field name as words: "performance_rows" → "performance rows", "errorCode" → "error code"."""
    return " ".join(_CAMEL.sub(r"\1 \2", key).replace("_", " ").replace("-", " ").lower().split())


def number(v: float) -> str:
    return f"{v:,}" if isinstance(v, int) or float(v).is_integer() else f"{v:,.4g}" if abs(v) < 1000 else f"{v:,.0f}"


def seconds(s: float) -> str:
    if s < 60:
        return f"{s:.1f} s"
    m, sec = divmod(round(s), 60)
    return f"{m}m {sec:02d}s" if m < 60 else f"{m // 60}h {m % 60:02d}m"


def _value(key: str, v: Any, text: bool) -> str | None:
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, (int, float)):
        return number(v)
    if isinstance(v, str) and v and text and len(v) <= 80 and "\n" not in v and not _UUID.match(v):
        return v
    if isinstance(v, (list, tuple)):
        if not v:
            return None
        if len(v) <= 6 and all(isinstance(x, str) and _NAME.match(x) and not _UUID.match(x) for x in v):
            return ", ".join(v)
        return count(len(v), "item")
    if isinstance(v, Mapping) and key in ("by_type", "counts", "totals"):
        inner = [f"{label(k)} {number(x)}" for k, x in v.items() if isinstance(x, (int, float)) and not isinstance(x, bool)]
        return "(" + ", ".join(inner[:6]) + ")" if inner else None
    return None


def facts(d: Mapping[str, Any] | None, *, skip: Iterable[str] = (), limit: int = 8, text_fields: Iterable[str] = TEXT_FIELDS) -> str:
    """A dict's plain values in words, in its own order: "documents 96, ingested 96, outcome synced". Numbers and
    yes/no always; strings only for TEXT_FIELDS (states, codes: never content); a short list of names as the names,
    any other list as "N items"; empty lists and ids are left out. Empty when there is nothing to say."""
    if not isinstance(d, Mapping):
        return ""
    out: list[str] = []
    skipped, texts = set(skip), set(text_fields)
    for k, v in d.items():
        if k in skipped or k.endswith(("_id", "Id", "_ids", "Ids")) or k in ("id", "ids"):
            continue
        s = _value(k, v, k in texts)
        if s is not None:
            out.append(f"{label(k)} {s}")
        if len(out) >= limit:
            break
    return ", ".join(out)


def shape(answer: Any, *, limit: int = 6) -> str:
    """What an answer holds, for a call's log line: facts of a dict ("status succeeded, rows 1,234, items 12"), or the
    length of a list ("12 items")."""
    if isinstance(answer, list):
        return count(len(answer), "item")
    if isinstance(answer, Mapping):
        return facts(answer, limit=limit)
    return ""
