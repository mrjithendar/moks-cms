"""3.4 Learned recommendation priority (docs/seo/ML.md "Priority", SCORING.md "Learned proposals").

Once ≥ 50 implemented recommendations have a 28-day outcome, LightGBM learns the outcome lift from the
recommendation's features. It never changes the scoring: it PROPOSES new weights for the six score inputs (a
non-negative least-squares fit of the lift on the inputs, the same quantities the weights multiply, cross-checked
with LightGBM's feature importance), shown next to the current weights with both rankings' NDCG@10 on held-out
outcomes. The owner approves a proposal in Settings → Scoring, which writes a new weights version.

Lift (one number per recommendation) = the change in clicks in the 28 days after "implemented" vs the 28 days before,
minus the page's own trend before that (the 28 days before minus the 28 before those), divided by
max(clicks in the 28 days before, 10). Observational, not a controlled experiment (SCORING.md).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import numpy as np

MIN_OUTCOMES = 50
INPUTS = ("searchOpportunity", "rankingOpportunity", "relevance", "qualityGap", "trend", "effort")
CATEGORIES = ("low_ctr", "striking_distance", "content_decay", "content_gap", "internal_links", "outdated_tech", "quality")
INTENTS = ("informational", "navigational", "commercial", "troubleshooting", "comparison")


def lift(baseline_clicks: float, post_clicks: float, pre_baseline_clicks: float | None) -> float:
    trend = (baseline_clicks - pre_baseline_clicks) if pre_baseline_clicks is not None else 0.0
    return ((post_clicks - baseline_clicks) - trend) / max(baseline_clicks, 10.0)


def position_band(pos: float | None) -> float:
    if pos is None:
        return -1.0
    return 0.0 if pos <= 3 else 1.0 if pos <= 10 else 2.0 if pos <= 20 else 3.0


FEATURES = (
    [f"in_{k}" for k in INPUTS]
    + [f"cat_{c}" for c in CATEGORIES]
    + ["position_band", "log_impressions", "ctr_gap", "decay_signal", "log_words", "internal_links", "cluster_size", "effort"]
    + [f"intent_{i}" for i in INTENTS]
)


def features(r: dict[str, Any]) -> list[float]:
    """r: inputs (dict of the six), category, position, impressions, ctr_gap, decaying (bool|None), words,
    internal_links, cluster_size, intent. Missing inputs are 0 with the category one-hot telling them apart."""
    ins = r.get("inputs") or {}
    v = [float(ins.get(k) or 0.0) for k in INPUTS]
    v += [1.0 if r.get("category") == c else 0.0 for c in CATEGORIES]
    v += [
        position_band(r.get("position")),
        float(np.log10(1 + float(r.get("impressions") or 0))),
        float(r.get("ctr_gap") or 0.0),
        1.0 if r.get("decaying") else 0.0,
        float(np.log10(1 + float(r.get("words") or 0))),
        float(r.get("internal_links") or 0),
        float(r.get("cluster_size") or 0),
        float(ins.get("effort") or 0.0),
    ]
    v += [1.0 if r.get("intent") == i else 0.0 for i in INTENTS]
    return v


def score_with(weights: Mapping[str, float], inputs: Mapping[str, Any]) -> float:
    """scoring.ts scoreOf: Σ wᵢ·xᵢ / Σ wᵢ over the inputs present."""
    num = den = 0.0
    for k in INPUTS:
        x = inputs.get(k)
        w = float(weights.get(k, 0))
        if x is None or not np.isfinite(float(x)):
            continue
        num += w * min(1.0, max(0.0, float(x)))
        den += w
    return num / den if den > 0 else 0.0


def ndcg_at(scores: np.ndarray, lifts: np.ndarray, k: int = 10) -> float:
    from sklearn.metrics import ndcg_score

    if len(scores) < 2:
        return 0.0
    rel = np.argsort(np.argsort(lifts)).astype(float)  # rank-transformed gains: robust to a few huge lifts
    return float(ndcg_score(rel[None, :], np.asarray(scores, dtype=float)[None, :], k=min(k, len(scores))))


@dataclass
class Proposal:
    weights: dict[str, int]
    metrics: dict[str, Any]


def propose(rows: list[dict[str, Any]], current: dict[str, float], version: str, seed: int = 7) -> tuple[Proposal | None, dict[str, Any]]:
    """rows: one per implemented recommendation with an outcome, oldest first (needs 'at' order), with `lift` set."""
    n = len(rows)
    if n < MIN_OUTCOMES:
        return None, {"status": "collecting_data", "n": n, "needed": MIN_OUTCOMES}
    import lightgbm as lgb
    from scipy.optimize import nnls

    cut = int(n * 0.8)
    tr, te = rows[:cut], rows[cut:]
    x_tr = np.asarray([features(r) for r in tr])
    y_tr = np.asarray([float(r["lift"]) for r in tr])
    x_te = np.asarray([features(r) for r in te])
    y_te = np.asarray([float(r["lift"]) for r in te])
    booster = lgb.train(
        {"objective": "regression", "num_leaves": 7, "learning_rate": 0.05, "min_data_in_leaf": 5, "deterministic": True, "seed": seed, "verbose": -1, "force_col_wise": True},
        lgb.Dataset(x_tr, y_tr, feature_name=list(FEATURES)),
        num_boost_round=150,
    )
    importance = dict(zip(FEATURES, (float(v) for v in booster.feature_importance("gain")), strict=True))
    # Constrained fit: non-negative weights on the six inputs (rows renormalised like scoreOf: missing inputs excluded).
    a = np.asarray([[float((r.get("inputs") or {}).get(k) or 0.0) for k in INPUTS] for r in tr])
    present = np.asarray([[1.0 if (r.get("inputs") or {}).get(k) is not None else 0.0 for k in INPUTS] for r in tr])
    a = a / np.clip(present.sum(axis=1, keepdims=True), 1, None)
    ranks = np.argsort(np.argsort(y_tr)) / max(1, len(y_tr) - 1)  # fit the rank of the lift: the weights only order
    w, _ = nnls(a, ranks)
    if w.sum() <= 0:
        w = np.asarray([float(current.get(k, 0)) for k in INPUTS])
    w = w / w.sum() * 100
    proposed = {k: round(float(v)) for k, v in zip(INPUTS, w, strict=True)}
    cur_scores = np.asarray([score_with(current, r.get("inputs") or {}) for r in te])
    new_scores = np.asarray([score_with(proposed, r.get("inputs") or {}) for r in te])
    lgb_scores = np.asarray(booster.predict(x_te), dtype=float)
    metrics = {
        "n": n,
        "train": len(tr),
        "test": len(te),
        "ndcg10_current": round(ndcg_at(cur_scores, y_te), 4),
        "ndcg10_proposed": round(ndcg_at(new_scores, y_te), 4),
        "ndcg10_lightgbm": round(ndcg_at(lgb_scores, y_te), 4),
        "importance_gain": {k: round(v, 2) for k, v in sorted(importance.items(), key=lambda kv: -kv[1])[:10]},
        "model_version": version,
    }
    return Proposal(proposed, metrics), metrics
