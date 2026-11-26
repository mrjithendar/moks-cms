"""3.5 Related articles from content similarity and reader paths (docs/seo/ML.md "Related articles").

score(a, b) = weighted sum of components in [0, 1]:
  similarity     PgVectorIndex.similar_articles (mean chunk embedding of a vs b's best chunk)
  covisit        GA4 landing page → page path views in the same sessions (seo_ga4_page_pairs, aggregate, 28 days),
                 symmetric, cosine-normalised: (v(a→b) + v(b→a)) / sqrt(total(a) · total(b)), total = views on every pair
                 the article is part of
  shared_queries Jaccard of the Search Console queries both pages get impressions for (90 days)
  category       1 for the same category
Weights: with co-visitation data 0.50 / 0.25 / 0.15 / 0.10; without it (the property doesn't support the dimension
pair, or no traffic yet) similarity 0.60, shared queries 0.25, category 0.15 — recorded per row in `components`.

Evaluation is an A/B split by article-id parity (the web app's public "Related articles" block shows this list on
even-parity articles, the existing tag/category list on the others) for at least 4 weeks, measured by the block's
click-through rate from GA4 events when configured; until then the model's status is "experiment_running".
"""

from __future__ import annotations

import math
from typing import Any

W_WITH = {"similarity": 0.50, "covisit": 0.25, "shared_queries": 0.15, "category": 0.10}
W_WITHOUT = {"similarity": 0.60, "shared_queries": 0.25, "category": 0.15}
TOP_K = 6
EXPERIMENT_DAYS = 28


def covisit_matrix(pairs: list[dict[str, Any]], path_to_id: dict[str, str]) -> dict[tuple[str, str], float]:
    """pairs: landing_page, page_path, views. Returns a symmetric normalised score per article pair."""
    v: dict[tuple[str, str], float] = {}
    total: dict[str, float] = {}  # views on every pair an article is part of, either direction
    for p in pairs:
        a, b = path_to_id.get(_path(p["landing_page"])), path_to_id.get(_path(p["page_path"]))
        if not a or not b or a == b:
            continue
        views = float(p["views"])
        v[(a, b)] = v.get((a, b), 0.0) + views
        total[a] = total.get(a, 0.0) + views
        total[b] = total.get(b, 0.0) + views
    res: dict[tuple[str, str], float] = {}
    for (a, b), x in v.items():
        sym = x + v.get((b, a), 0.0)
        res[(a, b)] = res[(b, a)] = min(1.0, sym / math.sqrt(max(total[a], 1.0) * max(total[b], 1.0)))
    return res


def _path(url_or_path: str) -> str:
    from urllib.parse import urlsplit

    s = str(url_or_path)
    s = urlsplit(s).path if "://" in s else s.split("?", 1)[0].split("#", 1)[0]
    return s.rstrip("/") or "/"


def jaccard(a: set[str], b: set[str]) -> float:
    return len(a & b) / len(a | b) if a and b else 0.0


def rank_related(
    article_id: str,
    similar: list[tuple[str, str, float]],
    covisit: dict[tuple[str, str], float],
    queries: dict[str, set[str]],
    category: dict[str, str],
    k: int = TOP_K,
) -> list[dict[str, Any]]:
    weights = W_WITH if covisit else W_WITHOUT
    out: list[dict[str, Any]] = []
    for rid, _p, sim in similar:
        if rid == article_id:
            continue
        comp = {
            "similarity": round(max(0.0, float(sim)), 4),
            "shared_queries": round(jaccard(queries.get(article_id, set()), queries.get(rid, set())), 4),
            "category": 1.0 if category.get(article_id) and category.get(article_id) == category.get(rid) else 0.0,
        }
        if covisit:
            comp["covisit"] = round(covisit.get((article_id, rid), 0.0), 4)
        score = sum(weights[c] * comp[c] for c in weights)
        out.append({"related_id": rid, "score": round(score, 4), "components": {**comp, "weights": weights}})
    out.sort(key=lambda r: (-float(r["score"]), str(r["related_id"])))
    return [{**r, "rank": i} for i, r in enumerate(out[:k], start=1)]


def experiment_arm(article_id: str) -> str:
    """A/B by article-id parity (last hex digit of the uuid): even → "model", odd → "rule". Same in TypeScript."""
    last = article_id.replace("-", "")[-1:].lower() or "0"
    return "model" if int(last, 16) % 2 == 0 else "rule"
