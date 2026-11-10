#!/usr/bin/env python3
"""Suggest an ASK_BLOG_MIN_SCORE (cosine pre-filter) from real Ask-the-Blog traffic. READ-ONLY: it prints a
recommendation and never changes configuration (docs/seo/RAG.md "Score calibration").

  DATABASE_URL=postgresql://… uv run python scripts/rag_calibrate.py [--days 30] [--min-answered 20] [--current 0.66]

Reads `seo_ask_log.retrieval` (migration 0018; rows logged since ask-blog-v3): for every excerpt that passed the floor,
its cosine, whether the grader kept it and whether the answer cited it.

- answered questions: the floor must keep every cited excerpt → the highest safe floor is the lowest cited cosine.
- fallback questions: how many would have had no excerpt at all under that floor (no grader call, and the reader gets
  the fallback faster) — the benefit of raising it.

The eval set gives a second, independent number (scripts/rag_eval.py "calibrated floor"); use the lower of the two.
Apply by hand: ASK_BLOG_MIN_SCORE in the seo-agent-config ConfigMap, then restart seo-agent.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from typing import Any


def suggest(rows: list[dict[str, Any]], min_answered: int = 20) -> dict[str, Any]:
    answered_min: list[float] = []
    fallback_max: list[float] = []
    for r in rows:
        ret = r.get("retrieval") or []
        if isinstance(ret, str):
            ret = json.loads(ret)
        if r["outcome"] == "answered":
            cited = [float(x["score"]) for x in ret if x.get("cited")]
            if cited:
                answered_min.append(min(cited))
        elif r["outcome"] == "fallback":
            fallback_max.append(max((float(x["score"]) for x in ret), default=0.0))
    out: dict[str, Any] = {"answered": len(answered_min), "fallback": len(fallback_max)}
    if len(answered_min) < min_answered:
        out["recommendation"] = None
        out["why"] = f"only {len(answered_min)} answered questions with logged retrieval (need {min_answered}); keep the eval-set floor"
        return out
    floor = math.floor(min(answered_min) * 100) / 100
    out["recommendation"] = floor
    out["fallbacks_cut"] = sum(1 for v in fallback_max if v < floor)
    out["answered_p05_cited_cosine"] = sorted(answered_min)[max(0, int(len(answered_min) * 0.05) - 1)]
    out["why"] = f"lowest cited-excerpt cosine over {len(answered_min)} answered questions, rounded down"
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL", ""))
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--min-answered", type=int, default=20)
    ap.add_argument("--current", type=float, default=float(os.environ.get("ASK_BLOG_MIN_SCORE", "0.66")))
    a = ap.parse_args()
    if not a.dsn:
        print("set DATABASE_URL or --dsn", file=sys.stderr)
        return 2
    import psycopg
    from psycopg.rows import dict_row

    with psycopg.connect(a.dsn, row_factory=dict_row) as c:
        c.execute("set transaction read only")
        rows = c.execute(
            "select outcome, retrieval from seo_ask_log where at > now() - make_interval(days => %s) and not cached and retrieval is not null and outcome in ('answered', 'fallback')",
            (a.days,),
        ).fetchall()
    s = suggest(rows, a.min_answered)
    print(json.dumps({"current": a.current, **s}, indent=2))
    if s["recommendation"] is None:
        print(f"\nNo change suggested: {s['why']}.")
    elif s["recommendation"] < a.current:
        print(f"\nA cited excerpt scored below the current floor ({a.current}): consider lowering ASK_BLOG_MIN_SCORE to {s['recommendation']}.")
    else:
        print(f"\nThe floor could rise to {s['recommendation']} without losing an answered question in the last {a.days} days "
              f"({s['fallbacks_cut']} of {s['fallback']} fallbacks would skip the grader). Compare with the eval-set floor before changing it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
