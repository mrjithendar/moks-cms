"""Redaction of secrets before anything is logged or stored in a run's history.

Applied to every log line (stderr JSON and the run's log in seo_flow_run_logs), every step's recorded detail, and model
call transcripts. Two passes:

- by key: a mapping key that names a secret (password, token, api_key, authorization, cookie, …) has its value replaced,
  whatever the value is;
- by shape: text that looks like a credential (an Anthropic, OpenAI or GitHub key, an AWS access key id, a Slack token, a
  bearer token, a JWT, a PEM private key, user:password in a URL) is replaced where it appears.

Redaction never raises: a value it cannot walk is returned as it is. Structures are walked to a fixed depth and size so
a huge payload cannot make logging slow.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

MASK = "[redacted]"
MAX_DEPTH = 8
MAX_ITEMS = 500

SECRET_KEY = re.compile(
    r"(^|[_\-.])(pass(word|wd|phrase)?|secret|token|api[_\-]?key|apikey|access[_\-]?key|private[_\-]?key|client[_\-]?secret|"
    r"authorization|auth[_\-]?header|cookie|set[_\-]?cookie|session[_\-]?id|credential|credentials|signature|dsn)($|[_\-.])",
    re.IGNORECASE,
)
# Keys that look like secrets by the rule above but are counts or names, never values (tokens used by a model call).
NOT_SECRET = frozenset({"tokens", "input_tokens", "output_tokens", "max_tokens", "total_tokens", "cache_read_tokens", "cache_creation_tokens", "token_count", "step_tokens", "report_tokens"})

PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"), MASK),
    (re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{16,}"), MASK),
    (re.compile(r"\bsk-(proj-)?[A-Za-z0-9_\-]{20,}"), MASK),
    (re.compile(r"\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}"), MASK),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"), MASK),
    (re.compile(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b"), MASK),
    (re.compile(r"\bxox[abprs]-[A-Za-z0-9\-]{10,}"), MASK),
    (re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}"), MASK),
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/\-]{12,}=*"), r"\1 " + MASK),
    (re.compile(r"(?i)(://[^/\s:@]{1,100}:)[^/\s@]{1,200}@"), r"\1" + MASK + "@"),
    (re.compile(r"(?i)\b(password|passwd|secret|api[_\-]?key|token)\s*[=:]\s*[^\s,;&\"']{4,}"), r"\1=" + MASK),
)


def secret_key(key: Any) -> bool:
    if not isinstance(key, str):
        return False
    k = key.strip().lower()
    return k not in NOT_SECRET and bool(SECRET_KEY.search(k))


def redact_text(text: str) -> str:
    """Credentials replaced where they appear in free text."""
    if not text or not isinstance(text, str):
        return text
    out = text
    for pattern, repl in PATTERNS:
        out = pattern.sub(repl, out)
    return out


def redact(value: Any, _depth: int = 0) -> Any:
    """A copy of `value` with secrets replaced: by key in mappings, by shape in text. Lists and tuples are walked."""
    try:
        if isinstance(value, str):
            return redact_text(value)
        if _depth >= MAX_DEPTH:
            return value
        if isinstance(value, Mapping):
            out: dict[Any, Any] = {}
            for i, (k, v) in enumerate(value.items()):
                if i >= MAX_ITEMS:
                    out["…"] = f"{len(value) - MAX_ITEMS} more"
                    break
                out[k] = MASK if secret_key(k) and v not in (None, "", [], {}) else redact(v, _depth + 1)
            return out
        if isinstance(value, (list, tuple)):
            items = [redact(v, _depth + 1) for v in list(value)[:MAX_ITEMS]]
            return items if isinstance(value, list) else tuple(items)
        return value
    except Exception:  # never let redaction break the caller
        return value


def preview(text: Any, limit: int = 500) -> str:
    """A short, redacted preview of a value for a step's recorded detail."""
    s = text if isinstance(text, str) else repr(text)
    s = redact_text(s)
    return s if len(s) <= limit else s[: limit - 1] + "…"


def metadata(value: Any, limit: int = 500) -> dict[str, Any]:
    """What a step records about an input or output: its type, size and (redacted, cut) preview, never the whole value."""
    if value is None:
        return {"type": "none"}
    if isinstance(value, str):
        return {"type": "text", "chars": len(value), "preview": preview(value, limit)}
    if isinstance(value, Mapping):
        values = {str(k): MASK if secret_key(k) else metadata(v, min(limit, 200)) for k, v in list(value.items())[:20]}
        return {"type": "object", "keys": sorted(str(k) for k in value)[:50], "values": values}
    if isinstance(value, (list, tuple)):
        return {"type": "list", "items": len(value)}
    return {"type": type(value).__name__, "preview": preview(value, limit)}
