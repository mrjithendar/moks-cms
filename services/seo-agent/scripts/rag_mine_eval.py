#!/usr/bin/env python3
"""Mine candidate eval questions from real Ask-the-Blog traffic, for a person to label (docs/seo/RAG.md "Evaluation").

Reads (read-only) seo_ask_log and seo_ask_gaps and writes YAML entries in the shape of tests/fixtures/rag_eval.yaml,
with `type`, `slugs` and `anchors` left for the labeller: nothing is labelled automatically (the retriever's own
answer is exactly what the eval must not trust). Each entry carries a `mined` block (why it was picked, how often it
was asked, the best cosine, what retrieval returned) as a labelling hint; delete it when the question moves into the
eval set.

Picked: questions that fell back ("no article yet"), and answered questions whose best retrieved cosine was below
--low-score (answers that barely cleared the floor). Open gaps from seo_ask_gaps come first, by times asked.

  uv run python scripts/rag_mine_eval.py --dsn "$DATABASE_URL" --days 30 --low-score 0.72 --out /tmp/candidates.yaml
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.rag_eval import load_eval_set  # noqa: E402
from app.services.ask_pipeline import normalize_question  # noqa: E402

LOG_SQL = """select normalized, min(question) as question, count(*)::int as asked, max(at) as last_at,
       bool_or(outcome = 'fallback') as fell_back,
       max((select max((x->>'score')::float8) from jsonb_array_elements(coalesce(retrieval, '[]'::jsonb)) x)) as best_score,
       (array_agg(retrieval order by at desc))[1] as retrieval
     from seo_ask_log
     where at >= now() - make_interval(days => %s) and outcome in ('answered', 'fallback') and not cached
     group by normalized"""
GAPS_SQL = "select normalized, sample_question, asked, status from seo_ask_gaps where status = 'open' order by asked desc limit %s"


def candidates(log_rows: list[dict[str, Any]], gaps: list[dict[str, Any]], *, low_score: float, known: set[str], limit: int) -> list[dict[str, Any]]:
    """Pure selection (tested): fallbacks and low-score answers, open gaps first, minus questions already in the set."""
    by_norm: dict[str, dict[str, Any]] = {}
    for g in gaps:
        n = g["normalized"]
        by_norm[n] = {"question": g["sample_question"], "reason": "open_gap", "asked": int(g["asked"]), "best_score": None, "retrieval": None}
    for r in log_rows:
        best = r.get("best_score")
        reason = "fallback" if r.get("fell_back") else ("low_score" if best is not None and best < low_score else None)
        if reason is None:
            continue
        cur = by_norm.get(r["normalized"])
        if cur:
            cur["asked"] = max(cur["asked"], int(r["asked"]))
            cur["best_score"], cur["retrieval"] = best, r.get("retrieval")
        else:
            by_norm[r["normalized"]] = {"question": r["question"], "reason": reason, "asked": int(r["asked"]), "best_score": best, "retrieval": r.get("retrieval")}
    rank = {"open_gap": 0, "fallback": 1, "low_score": 2}
    picked = [v for n, v in by_norm.items() if n not in known]
    picked.sort(key=lambda v: (rank[v["reason"]], -v["asked"], v["best_score"] if v["best_score"] is not None else -1))
    out = []
    for i, v in enumerate(picked[:limit], start=1):
        top = [f"{x.get('url')} ({float(x.get('score', 0)):.2f})" for x in (v["retrieval"] or [])[:3]]
        out.append(
            {
                "id": f"m{i:02d}",
                "question": str(v["question"])[:500],
                "type": None,  # to label: concept | how-to | exact-term | troubleshooting | no-answer
                "slugs": [],
                "anchors": [],
                "mined": {"reason": v["reason"], "asked": v["asked"], "best_score": None if v["best_score"] is None else round(float(v["best_score"]), 4), "retrieved": top},
            }
        )
    return out


def render(entries: list[dict[str, Any]]) -> str:
    head = (
        "# Candidate eval questions mined from Ask-the-Blog traffic (scripts/rag_mine_eval.py). NOT LABELLED.\n"
        "# For each: read the articles, set type / slugs / anchors by hand (or drop it), delete `mined`, and give it a\n"
        "# unique id before moving it into tests/fixtures/rag_eval.yaml. Never copy the retrieved URLs as labels.\n"
    )
    return head + yaml.safe_dump({"questions": entries}, sort_keys=False, allow_unicode=True, width=120)


async def fetch(dsn: str, days: int, gaps_limit: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    import psycopg
    from psycopg.rows import dict_row

    async with await psycopg.AsyncConnection.connect(dsn, autocommit=True, row_factory=dict_row) as c:
        await c.execute("set default_transaction_read_only = on")
        logs = await (await c.execute(LOG_SQL, (days,))).fetchall()
        gaps = await (await c.execute(GAPS_SQL, (gaps_limit,))).fetchall()
    return list(logs), list(gaps)


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--low-score", type=float, default=0.72, help="answered questions whose best cosine is below this are candidates")
    ap.add_argument("--limit", type=int, default=60)
    ap.add_argument("--out", default="-", help="output YAML file (- = stdout)")
    a = ap.parse_args()
    logs, gaps = await fetch(a.dsn, a.days, a.limit * 2)
    known = {normalize_question(q.question) for q in load_eval_set()}
    text = render(candidates(logs, gaps, low_score=a.low_score, known=known, limit=a.limit))
    if a.out == "-":
        sys.stdout.write(text)
    else:
        Path(a.out).write_text(text)  # noqa: ASYNC240 - a CLI: blocking file I/O is fine
        print(f"wrote {a.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
