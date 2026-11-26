"""Drafting help from the shared moks-rag service: internal links, the cannibalization check and a brief's grounding.

All three read the web app's articles from `cms_content` (RAG_CMS_COLLECTION; written by moks-cms, only read here),
and grounding also reads the agent's own `seo_intel` (app/seo_intel.py). No model is called: rag-api's own answer is
never asked for (app/moks_rag.py), and anchors, overlaps and flags are worked out in code from the retrieved text.

What a cms_content chunk's metadata must carry (the moks-cms side of the contract):
- Where the article lives: `url` or `canonical_url` (absolute, on SITE_URL's host), else `path` ("/blog/slug"), else
  `slug` (+ `collection`, default "blog"). A chunk with none of them, or a URL on another host, is skipped: nothing on
  another site is ever suggested as an internal link.
- `title`; optionally `heading` (or `section`) for the chunk's own heading, `target_keyword` (or `focus_keyword`),
  and `status`: when it is there, only "published" counts, so a draft is neither a link target nor a competitor.

rag-api's scores are Reciprocal Rank Fusion scores: they order one answer and are not similarities, so no fixed
number is compared with them. An article's rank (1 = best) is reported instead.

Cannibalization: an existing published article is flagged when
- its title holds every word of the target keyword (stemmed, stop words left out; keywords of two words or more, as
  almost every title on a one-topic blog holds a one-word keyword), or
- its own target keyword is the same, or
- RAG_CANNIBALIZATION_MIN_SIMILARITY is set and the article is at least that similar to the keyword (cosine in this
  service's embeddings model; nothing is preset, so this part is off until the owner sets a value).
A flag is a warning for the reviewer on the draft, never a block.
"""

from __future__ import annotations

import logging
import math
import re
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import asdict, dataclass, field
from typing import Any

from .moks_rag import RagChunk, RagClient
from .schemas import FactCheckFlag, InternalLinkSuggestion
from .seo_intel import site_path
from .seo_ml.clusters import STOP, normalize, tokens

log = logging.getLogger("seo_agent.site_context")

Embed = Callable[[list[str]], Awaitable[list[list[float]]]]
EXCERPT_CHARS = 500
LINK_TOP_K = 5  # existing articles returned for one draft
FETCH_FACTOR = 3  # chunks asked for per article wanted: one article often has several matching chunks


@dataclass(frozen=True)
class SiteArticle:
    """One existing article of the site, from its best-ranked chunk in an answer."""

    doc_id: str
    path: str
    url: str
    title: str
    rank: int  # 1 = the best article of this answer
    heading: str = ""
    target_keyword: str = ""
    text: str = ""

    @property
    def excerpt(self) -> str:
        return _excerpt(self.text)

    def brief(self) -> dict[str, Any]:
        return {"title": self.title, "url": self.url, "path": self.path, "section": self.heading, "excerpt": self.excerpt}


def article_ref(meta: dict[str, Any], site_url: str) -> str | None:
    """The site path a cms_content chunk belongs to, or None (no location, another host, not published)."""
    status = meta.get("status")
    if status is not None and str(status).lower() != "published":
        return None
    for key in ("url", "canonical_url", "path"):
        v = meta.get(key)
        if isinstance(v, str) and v.strip():
            return site_path(v, site_url)
    s = meta.get("slug")
    if isinstance(s, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,160}", s):
        coll = meta.get("collection")
        coll = coll if isinstance(coll, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,40}", coll) else "blog"
        return f"/{coll}/{s}"
    return None


def site_articles(chunks: Iterable[RagChunk], site_url: str, *, exclude: Iterable[str] = (), limit: int | None = None) -> list[SiteArticle]:
    """The distinct articles of an answer, best first (its first chunk), without `exclude` (paths or URLs)."""
    skip = {p for p in (site_path(e, site_url) for e in exclude if e) if p}
    base = site_url.rstrip("/")
    out: dict[str, SiteArticle] = {}
    for ch in chunks:
        path = article_ref(ch.metadata, site_url)
        if path is None or path in skip or path in out:
            continue
        m = ch.metadata
        heading = str(m.get("heading") or m.get("section") or m.get("heading_path") or "")
        kw = str(m.get("target_keyword") or m.get("focus_keyword") or "")
        out[path] = SiteArticle(ch.doc_id, path, f"{base}{path}", str(m.get("title") or "").strip(), len(out) + 1, heading.strip(), kw.strip(), ch.text)
        if limit is not None and len(out) >= limit:
            break
    return list(out.values())


# --- internal links ------------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class LinkSuggestion:
    url: str
    path: str
    title: str
    anchors: list[str]  # best first: words the draft already uses, then the target's section heading, then its title
    matched_heading: str  # the draft heading the link fits under best ("" = no heading shares a word with it)
    shared_terms: list[str]
    rank: int
    reason: str

    def as_internal_link(self) -> InternalLinkSuggestion:
        return InternalLinkSuggestion(target_path=self.path, anchor=self.anchors[0] if self.anchors else self.title, reason=self.reason)

    def out(self) -> dict[str, Any]:
        return asdict(self)


async def internal_links(rag: RagClient, *, title: str, headings: list[str], site_url: str, exclude: Iterable[str] = (), top_k: int = LINK_TOP_K) -> list[LinkSuggestion]:
    """Existing articles to link to from a draft, from its title and headings (one cms_content query)."""
    heads = [" ".join(h.split()) for h in headings if h and h.strip()][:40]
    query = "; ".join([" ".join(title.split()), *heads]).strip("; ")
    if not query:
        return []
    chunks = await rag.query_cms(query, top_k=top_k * FETCH_FACTOR)
    found = site_articles(chunks, site_url, exclude=exclude, limit=top_k)
    draft_terms = tokens(" ".join([title, *heads]))
    out = []
    for a in found:
        target_terms = tokens(f"{a.title} {a.heading}")
        shared = sorted(draft_terms & target_terms)
        matched = max(heads, key=lambda h: (len(tokens(h) & target_terms), -heads.index(h)), default="") if heads else ""
        if matched and not tokens(matched) & target_terms:
            matched = ""
        reason = f"#{a.rank} of {len(found)} existing articles for the draft's title and headings"
        if shared:
            reason += f"; shares {', '.join(shared[:6])}"
        if matched:
            reason += f"; fits under “{matched}”"
        out.append(LinkSuggestion(a.url, a.path, a.title, anchor_suggestions(a.title, a.heading, draft_terms), matched, shared[:8], a.rank, reason))
    log.info("internal links suggested", extra={"event": "rag_internal_links", "suggestions": len(out), "chunks": len(chunks)})
    return out


def anchor_suggestions(target_title: str, target_heading: str, draft_terms: set[str], limit: int = 3) -> list[str]:
    """Anchor texts for a link to an article: the longest part of its title (2–6 words) whose words the draft already
    uses, then the section's heading, then the title itself (shortened)."""
    words = target_title.split()
    shared = ""
    for n in range(min(6, len(words)), 1, -1):
        for i in range(len(words) - n + 1):
            if _stop(words[i]) or _stop(words[i + n - 1]):  # "TLS with", "to renew": an anchor starts and ends on a real word
                continue
            phrase = _trim(" ".join(words[i : i + n]))
            t = tokens(phrase)
            if len(t) >= 2 and t <= draft_terms:
                shared = phrase
                break
        if shared:
            break
    title = _trim(target_title) if len(target_title) <= 70 else _trim(" ".join(words[:8]))
    out: list[str] = []
    for a in (shared, _trim(target_heading.split("›")[-1]), title):
        if a and a.lower() not in {x.lower() for x in out}:
            out.append(a[:80])
    return out[:limit]


def _trim(s: str) -> str:
    return " ".join(s.split()).strip(" :;,.–—-|()[]\"'“”")


def _stop(word: str) -> bool:
    w = _trim(word).lower()
    return not w or w in STOP


# --- cannibalization -----------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Overlap:
    path: str
    url: str
    title: str
    rank: int
    keyword_in_title: bool
    same_target_keyword: bool
    similarity: float | None
    flagged: bool
    reasons: list[str]


@dataclass(frozen=True)
class CannibalizationReport:
    keyword: str
    checked: bool  # False: moks-rag not configured, or the query failed (`error`)
    flagged: bool
    matches: list[Overlap] = field(default_factory=list)
    min_similarity: float | None = None
    error: str | None = None

    @property
    def flagged_matches(self) -> list[Overlap]:
        return [m for m in self.matches if m.flagged]

    def as_flags(self) -> list[FactCheckFlag]:
        """Warnings for the reviewer of the new draft, one per existing article that covers the keyword."""
        return [
            FactCheckFlag(
                claim=f"Target keyword “{self.keyword}”",
                reason=f"May compete with the published article “{m.title or m.path}” ({m.url}): {'; '.join(m.reasons)}. Update that article instead, or make the new one clearly different and link to it.",
                severity="warning",
            )
            for m in self.flagged_matches
        ]

    def out(self) -> dict[str, Any]:
        return asdict(self)


def target_keyword(brief: dict[str, Any]) -> str:
    """The brief's target keyword: `targetKeyword` when the brief has one, else its first supporting Search Console
    query, else its title."""
    for v in (brief.get("targetKeyword"), *(brief.get("supportingQueries") or [])[:1], brief.get("title")):
        if isinstance(v, str) and v.strip():
            return " ".join(v.split())[:200]
    return ""


async def cannibalization(
    rag: RagClient,
    *,
    keyword: str,
    topic: str = "",
    site_url: str,
    exclude: Iterable[str] = (),
    embed: Embed | None = None,
    min_similarity: float | None = None,
    top_k: int = LINK_TOP_K,
) -> CannibalizationReport:
    """Does a published article already cover `keyword`? One cms_content query for the keyword (and the topic)."""
    kw = " ".join(keyword.split())
    if not kw:
        return CannibalizationReport(keyword="", checked=False, flagged=False, error="no target keyword")
    query = kw if not topic.strip() or normalize(topic) == normalize(kw) else f"{kw}; {' '.join(topic.split())}"
    found = site_articles(await rag.query_cms(query, top_k=top_k * FETCH_FACTOR), site_url, exclude=exclude, limit=top_k)
    kw_terms = tokens(kw)
    sims: list[float | None] = [None] * len(found)
    if embed is not None and min_similarity is not None and found:
        vecs = await embed([kw, *(f"{a.title}\n{a.heading}\n{a.text[:1500]}" for a in found)])
        sims = [round(_cosine(vecs[0], v), 4) for v in vecs[1:]]
    matches = []
    for a, sim in zip(found, sims, strict=True):
        in_title = len(kw_terms) >= 2 and kw_terms <= tokens(a.title)
        same_kw = bool(a.target_keyword) and normalize(a.target_keyword) == normalize(kw)
        close = sim is not None and min_similarity is not None and sim >= min_similarity
        reasons = []
        if in_title:
            reasons.append("its title has every word of the keyword")
        if same_kw:
            reasons.append("it targets the same keyword")
        if close:
            reasons.append(f"similarity {sim:.2f} ≥ {min_similarity:.2f}")
        matches.append(Overlap(a.path, a.url, a.title, a.rank, in_title, same_kw, sim, bool(reasons), reasons))
    report = CannibalizationReport(kw, True, any(m.flagged for m in matches), matches, min_similarity)
    log.info("cannibalization checked", extra={"event": "rag_cannibalization", "flagged": report.flagged, "matches": len(matches), "flagged_matches": len(report.flagged_matches)})
    return report


def _cosine(a: list[float], b: list[float]) -> float:
    na, nb = math.sqrt(sum(x * x for x in a)), math.sqrt(sum(x * x for x in b))
    return sum(x * y for x, y in zip(a, b, strict=False)) / (na * nb) if na and nb else 0.0


# --- grounding ----------------------------------------------------------------------------------------------------


async def grounding(rag: RagClient, brief: dict[str, Any], *, site_url: str, exclude: Iterable[str] = (), top_k: int = LINK_TOP_K) -> dict[str, list[dict[str, Any]]]:
    """Context for drafting a brief: keyword and Search Console intelligence from seo_intel (and the site's brand
    and style guidelines when they match), and what the site's published articles already say on the topic."""
    kw = target_keyword(brief)
    title = " ".join(str(brief.get("title") or "").split())
    queries = [str(q) for q in (brief.get("supportingQueries") or []) if isinstance(q, str)][:10]
    outline = [str(h) for h in (brief.get("outline") or []) if isinstance(h, str)][:20]
    seo_q = "; ".join(dict.fromkeys(x for x in [kw, title, *queries] if x))
    site_q = "; ".join(dict.fromkeys(x for x in [title, str(brief.get("gap") or ""), *outline] if x.strip()))
    seo = await rag.query_seo(seo_q, top_k=top_k) if seo_q else []
    site = site_articles(await rag.query_cms(site_q, top_k=top_k * FETCH_FACTOR), site_url, exclude=exclude, limit=top_k) if site_q else []
    return {
        "seo_intel": [
            {"type": c.metadata.get("type", ""), "target_keyword": c.metadata.get("target_keyword", ""), "title": c.metadata.get("title", ""), "updated_at": c.metadata.get("updated_at", ""), "excerpt": _excerpt(c.text, 900)}
            for c in seo
        ],
        "site_articles": [a.brief() for a in site],
    }


def _excerpt(text: str, limit: int = EXCERPT_CHARS) -> str:
    t = " ".join(text.split())
    return t if len(t) <= limit else t[: limit - 1].rsplit(" ", 1)[0] + "…"
