"""Fixes from the SEO-ML review: a decay review is tied to one method + configuration and to the real back-test; the
priority model trains only on pre-change snapshots and is promoted only when a bootstrap CI over time-ordered CV says
so; the intent classifier's threshold is tuned on a calibration split, never on the fold it is scored on."""

from __future__ import annotations

import itertools
from dataclasses import replace
from datetime import date, timedelta
from typing import Any

import numpy as np
import pytest

from app.seo_ml import decay as dc
from app.seo_ml import intent as it
from app.seo_ml import priority as pr
from app.seo_ml import train as tr
from app.seo_ml.store import MemoryMlStore

END = date(2026, 11, 1)


# --- 1. decay: review carry-over and the real back-test ---------------------------------------------------------------


def _fake_benchmark(beats: bool = True) -> Any:
    def bench(cfg: dc.DecayConfig = dc.DEFAULT_CONFIG, *a: Any, **k: Any) -> dict[str, Any]:
        side = {"false_alarms": 1, "false_alarm_rate": 0.01, "drop_recall": 0.9}
        return {"model": side, "rule": {**side, "false_alarms": 9}, "beats_rule": beats}

    return bench


def _fake_backtest(model_alerts: int = 4, rule_alerts: int = 4, jaccard: float | None = 0.6) -> Any:
    def bt(*a: Any, **k: Any) -> dict[str, Any]:
        return {"page_windows": 40, "model_alerts": model_alerts, "rule_alerts": rule_alerts, "model_alert_rate": model_alerts / 40, "rule_alert_rate": rule_alerts / 40, "agreement_jaccard": jaccard, "pages": 5}

    return bt


def _decay_store() -> MemoryMlStore:
    s = MemoryMlStore(gsc_end=END)
    y = dc.synthetic_series("stable", seed=3, n=150)
    s.daily = [{"page": "/blog/a", "date": END - timedelta(days=149 - i), "clicks": float(v), "impressions": 500.0} for i, v in enumerate(y)]
    return s


def _approve(s: MemoryMlStore) -> None:
    s.models[-1]["reviewed_by"] = "owner"  # what ml-admin.ts approveReview writes
    s.models[-1]["reviewed_at"] = "2026-11-02 10:00:00+00:00"


async def test_review_carries_over_only_for_the_same_method_and_config(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dc, "benchmark", _fake_benchmark())
    monkeypatch.setattr(dc, "backtest", _fake_backtest())
    s = _decay_store()
    r1 = (await tr.run_decay(s))["register"]
    assert r1["status"] == "needs_review" and not r1["active"]
    assert s.models[-1]["metrics"]["review_key"] == dc.review_key()
    _approve(s)
    r2 = (await tr.run_decay(s))["register"]
    assert r2["active"] and s.models[-1]["reviewed_by"] == "owner"  # same method, same config: the review holds
    # a configuration change needs a new review, although the (fixed-seed) benchmark still says "beats"
    changed = replace(dc.DEFAULT_CONFIG, min_drop=0.25)
    assert dc.config_hash(changed) != dc.config_hash()
    r3 = (await tr.run_decay(s, changed))["register"]
    assert not r3["active"] and r3["status"] == "needs_review" and s.models[-1]["reviewed_by"] is None
    assert await s.active_model("decay") is None


async def test_review_is_dropped_after_a_method_change(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dc, "benchmark", _fake_benchmark())
    monkeypatch.setattr(dc, "backtest", _fake_backtest())
    s = _decay_store()
    await tr.run_decay(s)
    _approve(s)
    monkeypatch.setattr(dc, "METHOD", "stl-v2")
    r = (await tr.run_decay(s))["register"]
    assert not r["active"] and s.models[-1]["reviewed_by"] is None and s.models[-1]["metrics"]["review_key"]["method"] == "stl-v2"


async def test_versions_reviewed_before_review_keys_existed_need_a_new_review() -> None:
    s = MemoryMlStore()
    s.models.append({"kind": "decay", "version": "v1", "metrics": {"backtest": {}}, "reviewed_by": "owner", "reviewed_at": "x", "active": True})
    r = await tr.register(s, "decay", n=1, model_metrics={}, rule_metrics={}, beats=True, needs_review=True, review_key=dc.review_key())
    assert not r["active"] and r["status"] == "needs_review"


async def test_review_is_dropped_when_agreement_with_the_rule_falls(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dc, "benchmark", _fake_benchmark())
    monkeypatch.setattr(dc, "backtest", _fake_backtest(jaccard=0.6))
    s = _decay_store()
    await tr.run_decay(s)
    _approve(s)
    monkeypatch.setattr(dc, "backtest", _fake_backtest(jaccard=0.6 - dc.MAX_JACCARD_DROP + 0.01))
    assert (await tr.run_decay(s))["register"]["active"]  # within the floor
    ref = s.models[-1]["metrics"]["reviewed_reference"]
    assert ref["version"] == "v1" and ref["backtest"]["agreement_jaccard"] == 0.6  # the floor is the REVIEWED version's
    monkeypatch.setattr(dc, "backtest", _fake_backtest(jaccard=0.6 - dc.MAX_JACCARD_DROP - 0.05))
    r = (await tr.run_decay(s))["register"]
    assert not r["active"] and r["run_status"] == "fallback_to_rule" and s.models[-1]["metrics"]["gates"]["agreement_with_reviewed_ok"] is False


async def test_activation_needs_back_test_alerts_within_k_times_the_rule(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dc, "benchmark", _fake_benchmark())
    monkeypatch.setattr(dc, "backtest", _fake_backtest())
    s = _decay_store()
    await tr.run_decay(s)
    _approve(s)
    storm = int(dc.MAX_ALERT_RATE_RATIO * 4 + dc.ALERT_SLACK) + 1
    monkeypatch.setattr(dc, "backtest", _fake_backtest(model_alerts=storm, rule_alerts=4))
    r = (await tr.run_decay(s))["register"]
    assert not r["active"] and not r["beats_rule"] and s.models[-1]["metrics"]["gates"]["backtest_alert_rate_ok"] is False


def test_back_test_gate_functions() -> None:
    assert dc.alert_rate_ok({"page_windows": 0})
    assert dc.alert_rate_ok({"page_windows": 10, "model_alerts": 2, "rule_alerts": 0})  # slack: one or two alerts can't decide
    assert not dc.alert_rate_ok({"page_windows": 10, "model_alerts": 9, "rule_alerts": 2})
    assert not dc.agreement_ok({"agreement_jaccard": 0.5}, None)  # nothing reviewed: no carry-over
    assert dc.agreement_ok({"agreement_jaccard": 0.5}, {"agreement_jaccard": None})
    assert dc.agreement_ok({"agreement_jaccard": 0.5}, {"agreement_jaccard": 0.6})
    assert not dc.agreement_ok({"agreement_jaccard": 0.3}, {"agreement_jaccard": 0.6})


def test_synthetic_benchmark_has_zero_inflated_and_step_series() -> None:
    sparse = dc.synthetic_series("sparse", seed=dc.HELD_OUT_SEEDS + 1)
    assert (sparse == 0).mean() > 0.2 and sparse.mean() < 8
    step = dc.synthetic_series("step", seed=dc.HELD_OUT_SEEDS + 2)
    assert step[-20:].mean() < 0.75 * step[:100].mean()
    up = dc.synthetic_series("step_up", seed=dc.HELD_OUT_SEEDS + 3)
    assert up[-30:].mean() > 1.2 * up[:50].mean()
    assert set(dc.KINDS) == {"stable", "holiday", "sparse", "step_up", "drop", "step"} and set(dc.POSITIVES) == {"drop", "step"}
    # held-out seeds never overlap the design seeds 0–2,999
    assert dc.HELD_OUT_SEEDS > 3000 + 1000 * max(dc._SEED_OFFSET.values())
    b = dc.benchmark(per_kind=2)
    assert set(b["counts"]["model"]) == set(dc.KINDS) and b["per_kind"] == 3


# --- 2. priority: leakage-free features, time-ordered CV, CI-gated promotion -----------------------------------------


def _raw(i: int, **extra: Any) -> dict[str, Any]:
    return {
        "id": f"r{i}",
        "category": "low_ctr",
        "implemented_at": f"2026-0{1 + i % 9}-01",
        "score_inputs": {"inputs": {"searchOpportunity": 0.4, "qualityGap": 0.7, "effort": 0.2}, "weights": {}},
        "baseline_metrics": {"clicks": 40.0, "impressions": 2000.0, "position": 7.5},
        "post_metrics_28d": {"clicks": 60.0, "impressions": 2100.0, "position": 6.0},
        "pre_baseline_clicks": 30.0,
        "position": 12.0,  # evidence at analysis time
        "impressions": 1500.0,
        **extra,
    }


def test_training_row_uses_pre_change_snapshots_only() -> None:
    row = pr.training_row(_raw(1))
    assert row is not None
    assert row["inputs"] == {"searchOpportunity": 0.4, "qualityGap": 0.7, "effort": 0.2}
    assert row["position"] == 7.5 and row["impressions"] == 2000.0  # baseline at "implemented" wins over evidence
    assert row["baseline_clicks"] == 40.0 and row["lift"] == pytest.approx(pr.lift(40, 60, 30))
    # post-change values (today's body, decay signal, intent, cluster) can't reach the features
    leaky = pr.training_row(_raw(1, words=9000, internal_links=40, decaying=True, intent="commercial", cluster_size=12))
    assert leaky is not None and pr.features(leaky) == pr.features(row)
    # evidence fills in when the baseline lacks position; JSON strings (some drivers) are parsed
    no_pos = pr.training_row(_raw(2, baseline_metrics='{"clicks": 10, "impressions": 100}'))
    assert no_pos is not None and no_pos["position"] == 12.0 and no_pos["impressions"] == 100
    assert pr.training_row(_raw(3, post_metrics_28d=None)) is None
    assert pr.training_row(_raw(4, baseline_metrics={"impressions": 5})) is None


def test_feature_set_has_no_duplicates_and_no_post_change_features() -> None:
    assert len(pr.FEATURES) == len(set(pr.FEATURES)) == len(pr.features(pr.training_row(_raw(1)) or {}))
    assert sum(1 for f in pr.FEATURES if "effort" in f) == 1  # was in_effort + effort
    for gone in ("ctr_gap", "decay_signal", "log_words", "internal_links", "cluster_size", *tuple(f"intent_{i}" for i in ("informational", "commercial"))):
        assert gone not in pr.FEATURES


async def test_run_priority_reads_outcomes_through_training_row() -> None:
    s = MemoryMlStore(outcome_rows=[_raw(i, words=i * 100) for i in range(10)] + [_raw(99, post_metrics_28d={})])
    out = await tr.run_priority(s)
    assert out["outcomes"] == 10 and out["register"]["status"] == "collecting_data"


def test_fast_ndcg_matches_sklearn_with_ties() -> None:
    from sklearn.metrics import ndcg_score

    rng = np.random.default_rng(1)
    for n in (5, 12, 30):
        scores = np.round(rng.uniform(size=n), 1)  # plenty of ties
        gains = rng.uniform(size=n)
        for k in (3, 10):
            kk = min(k, n)
            assert pr._ndcg(scores, gains, kk) == pytest.approx(float(ndcg_score(gains[None, :], scores[None, :], k=kk)))


def test_time_folds_are_expanding_and_never_train_on_newer_rows() -> None:
    folds = pr.time_folds(100)
    assert folds[0][0] == 50 and folds[-1][1] == 100
    assert all(a[1] == b[0] for a, b in itertools.pairwise(folds))  # contiguous test blocks, oldest first


def _outcomes(n: int, signal: float, seed: int = 11) -> list[dict[str, Any]]:
    rng = np.random.default_rng(seed)
    rows = []
    for _ in range(n):
        so, eff, rel = float(rng.uniform()), float(rng.uniform()), float(rng.uniform())
        rows.append({"inputs": {"searchOpportunity": so, "relevance": rel, "effort": eff}, "category": "low_ctr", "position": 6.0, "impressions": 500, "lift": signal * so + float(rng.normal(scale=0.3))})
    return rows


def test_promotion_needs_the_ci_lower_bound_above_zero() -> None:
    current = {"searchOpportunity": 5, "rankingOpportunity": 20, "relevance": 20, "qualityGap": 15, "trend": 10, "effort": 30}
    p, m = pr.propose(_outcomes(120, signal=3.0), current, "v1")
    assert p is not None and m["promote"] and m["ndcg10_diff_ci"][0] > 0 and len(m["folds"]) == pr.CV_FOLDS
    # pure noise: the proposal may even score a little higher on the point estimate, but the CI straddles 0
    p2, m2 = pr.propose(_outcomes(120, signal=0.0), current, "v1")
    assert p2 is not None and not m2["promote"] and m2["ndcg10_diff_ci"][0] <= 0 <= m2["ndcg10_diff_ci"][1]


async def test_run_priority_offers_no_proposal_without_a_significant_gain() -> None:
    raw = [
        {
            "id": f"r{i}",
            "category": "low_ctr",
            "score_inputs": {"inputs": r["inputs"]},
            "baseline_metrics": {"clicks": 100.0, "impressions": 500.0, "position": 6.0},
            "post_metrics_28d": {"clicks": 100.0 + 100.0 * r["lift"]},
        }
        for i, r in enumerate(_outcomes(120, signal=0.0))
    ]
    s = MemoryMlStore(outcome_rows=raw)
    out = await tr.run_priority(s)
    assert out["proposal"] is None and s.proposals == [] and "not above 0" in (s.models[-1]["notes"] or "")


# --- 3. intent: repeated stratified CV, threshold on a calibration split ---------------------------------------------


def _intent_data(n_per: int, seed: int = 5) -> tuple[np.ndarray, list[str]]:
    rng = np.random.default_rng(seed)
    centers = {k: rng.normal(size=16) for k in it.INTENTS}
    xs, ys = [], []
    for k in it.INTENTS:
        for i in range(n_per):
            xs.append(it.featurize(centers[k] + rng.normal(scale=0.9, size=16), f"q{i}"))
            ys.append(k)
    return np.stack(xs), ys


def test_intent_needs_min_train_labels() -> None:
    assert it.MIN_TRAIN >= 300
    x, y = _intent_data(it.MIN_TRAIN // 5 - 1)
    assert it.train(x, y, "v1")[0] is None


def test_cv_splits_keep_fit_calibration_and_test_disjoint() -> None:
    _x, y = _intent_data(70)
    seen = 0
    tests_by_repeat: dict[int, list[int]] = {}
    for rep, fit, cal, te in it.cv_splits(y):
        seen += 1
        assert not set(fit) & set(cal) and not set(fit) & set(te) and not set(cal) & set(te)
        assert len(set(fit) | set(cal) | set(te)) == len(y)
        tests_by_repeat.setdefault(rep, []).extend(int(i) for i in te)
    assert seen == it.CV_FOLDS * it.CV_REPEATS
    assert all(sorted(v) == list(range(len(y))) for v in tests_by_repeat.values())  # each repeat tests every row once


def test_intent_threshold_is_never_tuned_on_the_eval_fold(monkeypatch: pytest.MonkeyPatch) -> None:
    x, y = _intent_data(70)
    calibrated: list[set[int]] = []
    evaluated: list[set[int]] = []
    real_calibrate, real_splits = it.calibrate, it.cv_splits

    def spy_calibrate(model: it.IntentModel, xx: np.ndarray, yy: list[str], cal_idx: np.ndarray) -> None:
        calibrated.append({int(i) for i in cal_idx})
        real_calibrate(model, xx, yy, cal_idx)

    def spy_splits(yy: list[str], seed: int = 7) -> Any:
        for rep, fit, cal, te in real_splits(yy, seed):
            evaluated.append({int(i) for i in te})
            yield rep, fit, cal, te

    monkeypatch.setattr(it, "calibrate", spy_calibrate)
    monkeypatch.setattr(it, "cv_splits", spy_splits)
    model, m, oof = it.train(x, y, "v1")
    assert model is not None and len(evaluated) == it.CV_FOLDS * it.CV_REPEATS
    assert len(calibrated) == len(evaluated) + 1  # one per fold + the stored model's
    for cal, te in zip(calibrated, evaluated, strict=False):
        assert not cal & te
    assert len(oof) == len(y) and sorted(i for i, _p, _c in oof) == list(range(len(y)))
    assert m["test"] == len(y) and 0 <= m["accuracy_when_confident"] <= 1 and "macro_f1_std" in m


def test_tune_threshold() -> None:
    assert it.tune_threshold([0.99, 0.9, 0.8, 0.6], [True, True, True, False]) == 0.8
    assert it.tune_threshold([0.9, 0.8], [False, False]) == 0.95  # never accurate enough: the strictest threshold
    model = it.IntentModel("v1", ["a", "b"], np.zeros((2, 3)), np.zeros(2), threshold=0.812)
    again = it.IntentModel.from_bytes("v1", model.to_bytes())
    assert again.threshold == pytest.approx(0.812)


# --- PgMlStore.outcomes() against the real columns -------------------------------------------------------------------


@pytest.mark.postgres
async def test_pg_outcomes_returns_only_pre_change_columns(pool) -> None:  # type: ignore[no-untyped-def]
    from app.seo_ml.store import PgMlStore

    async with pool.connection() as c:
        await c.execute("create table seo_gsc_page_daily (date date, page text, search_type text, device text, country text, clicks bigint, impressions bigint, ctr float8, position float8)")
        await c.execute(
            """create table seo_recommendations (id uuid primary key default gen_random_uuid(), article_id uuid, url text, query text, category text not null,
               score_inputs jsonb not null default '{}', implementation_status text not null default 'not_started', implemented_at timestamptz,
               baseline_metrics jsonb, post_metrics_28d jsonb)"""
        )
        await c.execute("create table seo_recommendation_evidence (id uuid primary key default gen_random_uuid(), recommendation_id uuid not null, metric text not null, value double precision)")
        rid = (
            await (
                await c.execute(
                    """insert into seo_recommendations (url, category, score_inputs, implementation_status, implemented_at, baseline_metrics, post_metrics_28d)
                       values ('/a', 'low_ctr', '{"inputs": {"effort": 0.3}}', 'implemented', '2026-09-01', '{"clicks": 20, "position": 4}', '{"clicks": 30}') returning id"""
                )
            ).fetchone()
        )["id"]
        await c.execute("insert into seo_recommendation_evidence (recommendation_id, metric, value) values (%s, 'impressions', 900)", (rid,))
        await c.execute("insert into seo_gsc_page_daily values ('2026-07-20', '/a', 'web', 'mobile', 'ind', 12, 300, 0.04, 5)")
    rows = await PgMlStore(pool).outcomes()
    assert len(rows) == 1 and not {"words", "internal_links", "decaying", "intent", "cluster_size"} & set(rows[0])
    t = pr.training_row(rows[0])
    assert t is not None and t["inputs"] == {"effort": 0.3} and t["position"] == 4 and t["impressions"] == 900 and t["lift"] == pytest.approx(pr.lift(20, 30, 12))


try:  # the Postgres fixture (skips without a database)
    from tests.test_postgres import pool  # noqa: F401
except ImportError:  # pragma: no cover
    pass
