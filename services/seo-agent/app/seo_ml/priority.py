"""3.4 Learned recommendation priority (docs/seo/ML.md "Priority", SCORING.md "Learned proposals").

Once ≥ 50 implemented recommendations have a 28-day outcome, LightGBM learns the outcome lift from the
recommendation's features. It never changes the scoring: it PROPOSES new weights for the six score inputs (a
non-negative least-squares fit of the lift on the inputs, the same quantities the weights multiply, cross-checked
with LightGBM's feature importance), shown next to the current weights with both rankings' NDCG@10 on held-out
outcomes. The owner approves a proposal in Settings → Scoring, which writes a new weights version.

Lift (one number per recommendation) = the change in clicks in the 28 days after "implemented" vs the 28 days before,
minus the page's own trend before that (the 28 days before minus the 28 before those), divided by
max(clicks in the 28 days before, 10). Observational, not a controlled experiment (SCORING.md).

Features are only what was known BEFORE the change (`training_row`): the score inputs frozen on the recommendation
when it left review, its evidence (also frozen then), and the baseline window captured at "implemented". Anything read
from today's tables (the post body after the edit, today's decay signal, intent or cluster) would describe the page
after the change, i.e. leak the outcome, so it isn't a feature.

Evaluation: time-ordered expanding-window cross-validation (fold f trains on everything older than its test block),
and a bootstrap confidence interval of the NDCG@10 difference (proposed − current). A proposal is offered only when the
interval's lower bound is above 0.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import numpy as np

MIN_OUTCOMES = 50
INPUTS = ("searchOpportunity", "rankingOpportunity", "relevance", "qualityGap", "trend", "effort")
CATEGORIES = ("low_ctr", "striking_distance", "content_decay", "content_gap", "internal_links", "outdated_tech", "quality")
# Time-ordered CV: the first fold trains on the oldest MIN_TRAIN_SHARE of outcomes; the rest is cut into CV_FOLDS test
# blocks, each trained on everything before it (expanding window), so no fold is scored on outcomes older than its
# training data.
CV_FOLDS = 4
MIN_TRAIN_SHARE = 0.5
# Bootstrap of the NDCG difference: resample each fold's test block with replacement BOOTSTRAP times; the proposal is
# promoted only if the lower end of the CI_LEVEL interval of the mean (over folds) difference is above 0.
BOOTSTRAP = 1000
CI_LEVEL = 0.95


def lift(baseline_clicks: float, post_clicks: float, pre_baseline_clicks: float | None) -> float:
    trend = (baseline_clicks - pre_baseline_clicks) if pre_baseline_clicks is not None else 0.0
    return ((post_clicks - baseline_clicks) - trend) / max(baseline_clicks, 10.0)


def position_band(pos: float | None) -> float:
    if pos is None:
        return -1.0
    return 0.0 if pos <= 3 else 1.0 if pos <= 10 else 2.0 if pos <= 20 else 3.0


def _obj(v: Any) -> dict[str, Any]:
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            return {}
    return v if isinstance(v, dict) else {}


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if np.isfinite(f) else None


def training_row(raw: Mapping[str, Any]) -> dict[str, Any] | None:
    """One outcomes() row → a training row, from pre-change snapshots only; None without baseline/28-day clicks.

    - inputs: `score_inputs.inputs`, frozen when the recommendation left review (the web app re-scores pending ones only);
    - position / impressions: the baseline window stored at "implemented" (28 days before), else the recommendation's
      evidence (frozen at the same time as the inputs);
    - baseline clicks: the same baseline window.
    Every other column of the raw row is ignored on purpose."""
    base, post = _obj(raw.get("baseline_metrics")), _obj(raw.get("post_metrics_28d"))
    b_clicks, p_clicks = _num(base.get("clicks")), _num(post.get("clicks"))
    if b_clicks is None or p_clicks is None:
        return None
    si = _obj(raw.get("score_inputs"))
    ins = _obj(si.get("inputs"))
    inputs = {k: f for k in INPUTS if (f := _num(ins.get(k))) is not None}
    position = _num(base.get("position"))
    impressions = _num(base.get("impressions"))
    return {
        "id": raw.get("id"),
        "implemented_at": raw.get("implemented_at"),
        "inputs": inputs,
        "category": raw.get("category"),
        "position": position if position is not None else _num(raw.get("position")),
        "impressions": impressions if impressions is not None else _num(raw.get("impressions")),
        "baseline_clicks": b_clicks,
        "lift": lift(b_clicks, p_clicks, _num(raw.get("pre_baseline_clicks"))),
    }


FEATURES = [f"in_{k}" for k in INPUTS] + [f"cat_{c}" for c in CATEGORIES] + ["position_band", "log_impressions", "log_baseline_clicks"]


def features(r: Mapping[str, Any]) -> list[float]:
    """r: a `training_row`. Missing inputs are 0 with the category one-hot telling them apart."""
    ins = r.get("inputs") or {}
    v = [float(ins.get(k) or 0.0) for k in INPUTS]
    v += [1.0 if r.get("category") == c else 0.0 for c in CATEGORIES]
    v += [
        position_band(r.get("position")),
        float(np.log10(1 + max(0.0, float(r.get("impressions") or 0)))),
        float(np.log10(1 + max(0.0, float(r.get("baseline_clicks") or 0)))),
    ]
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


def _ndcg(scores: np.ndarray, gains: np.ndarray, k: int) -> float:
    """sklearn.metrics.ndcg_score for one list (ties in `scores` share their gain, ignore_ties=False), in numpy: the
    bootstrap calls it thousands of times."""
    n = len(scores)
    disc = 1.0 / np.log2(np.arange(n) + 2.0)
    disc[k:] = 0.0
    cum = np.cumsum(disc)
    _, inv, counts = np.unique(-scores, return_inverse=True, return_counts=True)
    ranked = np.zeros(len(counts))
    np.add.at(ranked, inv, gains)
    ranked /= counts
    ends = np.cumsum(counts) - 1
    sums = np.diff(np.concatenate([[0.0], cum[ends]]))
    dcg = float((ranked * sums).sum())
    ideal = float((np.sort(gains)[::-1] * disc).sum())
    return dcg / ideal if ideal > 0 else 0.0


def ndcg_at(scores: np.ndarray, lifts: np.ndarray, k: int = 10) -> float:
    if len(scores) < 2:
        return 0.0
    rel = np.argsort(np.argsort(lifts, kind="stable"), kind="stable").astype(float)  # rank gains: robust to a few huge lifts
    return _ndcg(np.asarray(scores, dtype=float), rel, min(k, len(scores)))


def time_folds(n: int, folds: int = CV_FOLDS, min_train_share: float = MIN_TRAIN_SHARE) -> list[tuple[int, int]]:
    """Expanding-window folds over rows sorted oldest first: (test_start, test_end); fold f trains on rows[:test_start]."""
    start = int(n * min_train_share)
    size = (n - start) // folds
    return [(start + f * size, n if f == folds - 1 else start + (f + 1) * size) for f in range(folds)]


def fit_weights(rows: list[dict[str, Any]], current: Mapping[str, float]) -> dict[str, int]:
    """Non-negative weights on the six inputs (rows renormalised like scoreOf), fitted to the lift's rank, scaled to 100."""
    from scipy.optimize import nnls

    a = np.asarray([[float((r.get("inputs") or {}).get(k) or 0.0) for k in INPUTS] for r in rows])
    present = np.asarray([[1.0 if (r.get("inputs") or {}).get(k) is not None else 0.0 for k in INPUTS] for r in rows])
    a = a / np.clip(present.sum(axis=1, keepdims=True), 1, None)
    y = np.asarray([float(r["lift"]) for r in rows])
    ranks = np.argsort(np.argsort(y)) / max(1, len(y) - 1)  # fit the rank of the lift: the weights only order
    w, _ = nnls(a, ranks)
    if w.sum() <= 0:
        w = np.asarray([float(current.get(k, 0)) for k in INPUTS])
    w = w / w.sum() * 100 if w.sum() > 0 else np.full(len(INPUTS), 100 / len(INPUTS))
    return {k: round(float(v)) for k, v in zip(INPUTS, w, strict=True)}


def bootstrap_diff_ci(folds: list[tuple[np.ndarray, np.ndarray, np.ndarray]], seed: int = 7, b: int = BOOTSTRAP, level: float = CI_LEVEL) -> tuple[float, float]:
    """folds: (proposed scores, current scores, lifts) per test block. CI of the mean over folds of
    NDCG@10(proposed) − NDCG@10(current), resampling each block's rows with replacement."""
    rng = np.random.default_rng(seed)
    diffs = np.empty(b)
    for i in range(b):
        d = 0.0
        for new, cur, y in folds:
            idx = rng.integers(0, len(y), len(y))
            d += ndcg_at(new[idx], y[idx]) - ndcg_at(cur[idx], y[idx])
        diffs[i] = d / len(folds)
    lo, hi = np.quantile(diffs, [(1 - level) / 2, 1 - (1 - level) / 2])
    return float(lo), float(hi)


@dataclass
class Proposal:
    weights: dict[str, int]
    metrics: dict[str, Any]


def propose(rows: list[dict[str, Any]], current: dict[str, float], version: str, seed: int = 7) -> tuple[Proposal | None, dict[str, Any]]:
    """rows: `training_row`s, oldest first, with `lift` set. Returns the proposal (weights fitted on all rows) and the
    cross-validated metrics; `metrics["promote"]` says whether the proposal beats the current weights (CI > 0)."""
    n = len(rows)
    if n < MIN_OUTCOMES:
        return None, {"status": "collecting_data", "n": n, "needed": MIN_OUTCOMES}
    import lightgbm as lgb

    params = {"objective": "regression", "num_leaves": 7, "learning_rate": 0.05, "min_data_in_leaf": 5, "deterministic": True, "seed": seed, "verbose": -1, "force_col_wise": True}

    def booster(train: list[dict[str, Any]]) -> Any:
        x = np.asarray([features(r) for r in train])
        y = np.asarray([float(r["lift"]) for r in train])
        return lgb.train(params, lgb.Dataset(x, y, feature_name=list(FEATURES)), num_boost_round=150)

    per_fold: list[dict[str, Any]] = []
    scored: list[tuple[np.ndarray, np.ndarray, np.ndarray]] = []
    lgb_ndcg: list[float] = []
    for start, end in time_folds(n):
        tr, te = rows[:start], rows[start:end]
        w = fit_weights(tr, current)
        y = np.asarray([float(r["lift"]) for r in te])
        cur = np.asarray([score_with(current, r.get("inputs") or {}) for r in te])
        new = np.asarray([score_with(w, r.get("inputs") or {}) for r in te])
        lg = np.asarray(booster(tr).predict(np.asarray([features(r) for r in te])), dtype=float)
        scored.append((new, cur, y))
        lgb_ndcg.append(ndcg_at(lg, y))
        per_fold.append({"train": len(tr), "test": len(te), "ndcg10_current": round(ndcg_at(cur, y), 4), "ndcg10_proposed": round(ndcg_at(new, y), 4)})
    nd_cur = float(np.mean([f["ndcg10_current"] for f in per_fold]))
    nd_new = float(np.mean([f["ndcg10_proposed"] for f in per_fold]))
    lo, hi = bootstrap_diff_ci(scored, seed=seed)
    full = booster(rows)
    importance = dict(zip(FEATURES, (float(v) for v in full.feature_importance("gain")), strict=True))
    proposed = fit_weights(rows, current)
    metrics = {
        "n": n,
        "cv": f"expanding window, {CV_FOLDS} folds, first trains on the oldest {int(MIN_TRAIN_SHARE * 100)} %",
        "folds": per_fold,
        "train": per_fold[0]["train"],
        "test": sum(f["test"] for f in per_fold),
        "ndcg10_current": round(nd_cur, 4),
        "ndcg10_proposed": round(nd_new, 4),
        "ndcg10_lightgbm": round(float(np.mean(lgb_ndcg)), 4),
        "ndcg10_diff": round(nd_new - nd_cur, 4),
        "ndcg10_diff_ci": [round(lo, 4), round(hi, 4)],
        "ci_level": CI_LEVEL,
        "bootstrap": BOOTSTRAP,
        "promote": lo > 0,
        "features": list(FEATURES),
        "importance_gain": {k: round(v, 2) for k, v in sorted(importance.items(), key=lambda kv: -kv[1])[:10]},
        "model_version": version,
    }
    return Proposal(proposed, metrics), metrics
