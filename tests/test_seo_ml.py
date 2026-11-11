"""SEO v5 Phase 3: STL decay on synthetic series, HDBSCAN clustering on fixtures, the intent classifier and its
activation gate, the 50-outcome gate of the learned priority, related-article ranking, the registry's activation and
fallback rules, and seo_ml_flow end to end on the in-memory store."""

from __future__ import annotations

import re
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pytest

from app import metrics
from app.seo_ml import clusters as cl
from app.seo_ml import decay as dc
from app.seo_ml import intent as it
from app.seo_ml import priority as pr
from app.seo_ml import related as rl
from app.seo_ml import train as tr
from app.seo_ml.stl import stl
from app.seo_ml.store import MemoryMlStore

END = date(2026, 11, 1)
IMPS = np.full(400, 1000.0)


# --- 3.1 decay -------------------------------------------------------------------------------------------------------


def test_stl_recovers_a_weekly_pattern_and_trend() -> None:
    t = np.arange(140)
    week = np.array([1.0, 1.1, 1.1, 1.05, 1.0, 0.6, 0.55])
    y = (40 + 0.1 * t) * week[t % 7]
    d = stl(y, 7, trend=45, outer=3)
    assert np.abs(d.trend[20:-20] - (40 + 0.1 * t[20:-20]) * week.mean()).max() < 1.5
    assert d.seasonal[5] < 0 < d.seasonal[1]  # weekend low, weekday high


def test_weekly_pattern_without_decay_is_not_flagged() -> None:
    for seed in range(5):
        y = dc.synthetic_series("stable", seed=90_000 + seed)
        assert not dc.detect(y, IMPS[: len(y)], END, "p").decaying


def test_sustained_drop_is_flagged_with_evidence() -> None:
    y = dc.synthetic_series("drop", seed=90_100)
    s = dc.detect(y, IMPS[: len(y)], END, "/blog/x")
    assert s.decaying and s.method_version == dc.METHOD and s.drop_pct and s.drop_pct > 0.2
    assert len(s.evidence["dates"]) == len(s.evidence["actual"]) == len(s.evidence["trend"]) == 120
    assert s.evidence["dates"][-1] == END.isoformat()


def test_two_years_of_history_use_yearly_seasonality_and_still_catch_a_drop() -> None:
    t = np.arange(800)
    yearly = 1 + 0.3 * np.sin(2 * np.pi * t / 365)
    for seed in range(3):
        drop = dc.synthetic_series("drop", seed=95_000 + seed, n=800) * yearly
        stable = dc.synthetic_series("stable", seed=95_100 + seed, n=800) * yearly
        s = dc.detect(drop, np.full(800, 1000.0), END, "p")
        assert s.decaying and s.evidence["periods"] == [7, 365]
        assert not dc.detect(stable, np.full(800, 1000.0), END, "p").decaying


def test_holiday_dip_is_not_flagged_although_the_rule_flags_it() -> None:
    rng = np.random.default_rng(4)
    t = np.arange(180)
    base = 40 * np.array([1.05, 1.12, 1.1, 1.06, 1.0, 0.62, 0.55])[t % 7]
    base[153:169] *= 0.3  # a two-week holiday dip inside the last 28 days, ended 11 days ago
    y = rng.poisson(base).astype(float)
    assert dc.rule_flags(y)  # 28 days vs the 28 before: −37 %
    assert not dc.detect(y, IMPS[:180], END, "p").decaying


def test_insufficient_history_keeps_the_rule() -> None:
    y = dc.synthetic_series("drop", seed=1, n=100)
    s = dc.detect(y, IMPS[:100], END, "p")
    assert s.method_version == dc.INSUFFICIENT and not s.decaying and "100 days" in s.evidence["reason"]
    low = dc.detect(dc.synthetic_series("drop", seed=1), np.zeros(180), END, "p")
    assert low.method_version == dc.INSUFFICIENT and "impressions" in low.evidence["reason"]


def test_benchmark_on_held_out_seeds_beats_the_rule() -> None:
    b = dc.benchmark(per_kind=20)
    assert b["seed_base"] == dc.HELD_OUT_SEEDS
    assert b["model"]["false_alarms"] < b["rule"]["false_alarms"] and b["model"]["drop_recall"] >= b["rule"]["drop_recall"] and b["beats_rule"]


def test_daily_series_and_backtest() -> None:
    rows = [{"page": "/a", "date": END - timedelta(days=i), "clicks": 10.0, "impressions": 200.0} for i in range(200)]
    s = dc.daily_series(rows, END)
    assert len(s["/a"][0]) == 200 and s["/a"][0].sum() == 2000
    bt = dc.backtest(s, END, windows=3)
    assert bt["page_windows"] == 3 and bt["model_alert_rate"] == 0


# --- 3.2 clusters ----------------------------------------------------------------------------------------------------


def _cluster_fixture() -> tuple[list[dict], np.ndarray, dict[str, str]]:
    rng = np.random.default_rng(3)
    topics = {
        "istio mtls": ["istio strict mtls", "enable mtls istio", "istio peerauthentication strict", "mtls between sidecars", "istio mutual tls minikube"],
        "terraform state": ["terraform state lock", "terraform s3 backend locking", "terraform state file", "remote state terraform", "terraform lock dynamodb"],
        "valkey": ["valkey sentinel", "valkey vs redis", "valkey helm chart", "redis sentinel failover valkey", "valkey minikube"],
    }
    centers = {t: rng.normal(size=32) for t in topics}
    rows, vecs, labels = [], [], {}
    for t, qs in topics.items():
        for i, q in enumerate(qs):
            rows.append({"query": q, "impressions": 100 - i * 10})
            vecs.append(centers[t] + rng.normal(scale=0.15, size=32))
            labels[q] = t
    for q in ["sourdough starter", "kafka rebalancing"]:  # noise → singletons
        rows.append({"query": q, "impressions": 5})
        vecs.append(rng.normal(size=32) * 3)
        labels[q] = q
    v = np.asarray(vecs)
    return rows, v / np.linalg.norm(v, axis=1, keepdims=True), labels


def test_hdbscan_groups_topics_names_by_top_query_and_keeps_noise_as_singletons() -> None:
    rows, vecs, labels = _cluster_fixture()
    m = cl.hdbscan_clusters(rows, vecs)
    assert len({m[q][0] for q in labels if labels[q] == "istio mtls"}) == 1
    assert m["enable mtls istio"][1] == "istio strict mtls"  # highest impressions in the cluster
    assert m["sourdough starter"] == (m["sourdough starter"][0], "sourdough starter") and m["sourdough starter"][0] != m["kafka rebalancing"][0]
    ev = cl.evaluate(labels, m, cl.token_set_clusters(rows))
    assert ev["model"]["ari"] > ev["rule"]["ari"] and ev["model"]["inverse_purity"] > ev["rule"]["inverse_purity"]
    assert ev["rule"]["clusters"] > ev["model"]["clusters"]  # token sets over-split
    assert not cl.beats_rule(ev)  # only 17 labelled queries: below MIN_LABELLED
    gate = {"n": cl.MIN_LABELLED, "model": {"ari": 0.6, "purity": 0.92}, "rule": {"ari": 0.4, "purity": 0.96}}
    assert cl.beats_rule(gate)  # purity within the 0.05 tolerance
    assert not cl.beats_rule({**gate, "model": {"ari": 0.6, "purity": 0.9}})
    assert not cl.beats_rule({**gate, "model": {"ari": 0.4, "purity": 1.0}})  # ARI must be strictly higher


def test_token_set_clusters_match_the_web_rule() -> None:
    rows = [{"query": "terraform state locking", "impressions": 50}, {"query": "terraform state lock", "impressions": 40}, {"query": "kubernetes ingress", "impressions": 30}]
    out = cl.token_set_clusters(rows)
    assert out["terraform state lock"] == (1, "terraform state locking") and out["kubernetes ingress"][0] == 2
    assert cl.tokens("Locking states") == {"lock", "state"}


def test_labelling_sample_mixes_head_and_tail() -> None:
    rows = [{"query": f"q{i}", "impressions": 1000 - i} for i in range(500)]
    s = cl.sample_for_labelling(rows, 200)
    assert len(s) == len(set(s)) == 200 and s[:100] == [f"q{i}" for i in range(100)] and any(int(q[1:]) >= 200 for q in s[100:])


# --- 3.3 intent ------------------------------------------------------------------------------------------------------


def _intent_data(n_per: int = 70) -> tuple[np.ndarray, list[str], list[str]]:
    rng = np.random.default_rng(5)
    tmpl = {"troubleshooting": "{} error not working", "comparison": "{} vs alternative", "informational": "what is {}", "commercial": "best {} course", "navigational": "{} docs login"}
    centers = {k: rng.normal(size=16) for k in tmpl}
    qs, ys, xs = [], [], []
    for k, t in tmpl.items():
        for i in range(n_per):
            q = t.format(f"tool{i}")
            qs.append(q)
            ys.append(k)
            xs.append(it.featurize(centers[k] + rng.normal(scale=0.3, size=16), q))
    return np.stack(xs), ys, qs


def test_intent_classifier_trains_with_a_confidence_threshold_and_serialises() -> None:
    x, y, _q = _intent_data()
    model, m, test = it.train(x, y, "v1")
    assert model is not None and m["macro_f1"] >= 0.85 and 0.5 <= model.threshold <= 0.95 and len(test) == len(y)
    again = it.IntentModel.from_bytes("v1", model.to_bytes())
    assert again.predict(x[:3]) == model.predict(x[:3])


def test_intent_fallback_threshold_and_activation_gate() -> None:
    x, y, _q = _intent_data()
    model, _m, _ = it.train(x, y, "v1")
    assert model is not None
    model.threshold = 0.99
    preds = model.predict(x)
    assert any(c < 0.99 for _, c in preds)  # below the threshold → the web app asks Haiku instead
    assert it.ready_to_activate({"macro_f1": 0.8}, 50, 50) == (False, "macro-F1 0.800 < 0.85")
    assert it.ready_to_activate({"macro_f1": 0.9}, 10, 50)[0] is False
    assert it.ready_to_activate({"macro_f1": 0.9}, 7, 7)[0] is True  # fewer disagreements than 50: all must be checked
    assert it.train(x[:10], y[:10], "v1")[0] is None  # below MIN_TRAIN


def test_intent_rules_match_the_web_rule() -> None:
    assert it.rule_intent("crashloopbackoff fix") == "troubleshooting"
    assert it.rule_intent("helm vs kustomize") == "comparison"
    assert it.rule_intent("jithendar blog") == "navigational"


def test_intent_prompt_version_matches_the_web_app() -> None:
    src = (Path(__file__).resolve().parents[2] / "www" / "src" / "lib" / "seo-intel" / "keywords.ts").read_text()
    assert re.search(r'INTENT_PROMPT_VERSION = "([^"]+)"', src).group(1) == it.INTENT_PROMPT_VERSION  # type: ignore[union-attr]


# --- 3.4 priority ----------------------------------------------------------------------------------------------------


def _outcomes(n: int) -> list[dict]:
    rng = np.random.default_rng(11)
    rows = []
    for _ in range(n):
        so, eff = float(rng.uniform()), float(rng.uniform())
        rows.append({"inputs": {"searchOpportunity": so, "relevance": float(rng.uniform()), "effort": eff}, "category": "low_ctr", "position": 6.0, "impressions": 500, "lift": 2 * so + float(rng.normal(scale=0.1))})
    return rows


def test_priority_is_gated_at_50_outcomes() -> None:
    p, m = pr.propose(_outcomes(49), {"searchOpportunity": 30, "effort": 30, "relevance": 30}, "v1")
    assert p is None and m == {"status": "collecting_data", "n": 49, "needed": 50}


def test_priority_proposes_weights_that_rank_held_out_outcomes_better() -> None:
    current = {"searchOpportunity": 5, "rankingOpportunity": 20, "relevance": 20, "qualityGap": 15, "trend": 10, "effort": 30}
    p, m = pr.propose(_outcomes(120), current, "v1")
    assert p is not None and set(p.weights) == set(pr.INPUTS) and abs(sum(p.weights.values()) - 100) <= 3
    assert p.weights["searchOpportunity"] == max(p.weights.values())
    assert m["ndcg10_proposed"] > m["ndcg10_current"] and m["test"] == 60 and m["promote"] and m["ndcg10_diff_ci"][0] > 0


def test_lift_is_relative_to_the_pages_own_trend() -> None:
    assert pr.lift(100, 130, 100) == pytest.approx(0.3)
    assert pr.lift(100, 130, 70) == pytest.approx(0.0)  # it was already rising by 30
    assert pr.lift(0, 5, None) == pytest.approx(0.5)  # small baselines divided by 10, not 0


# --- 3.5 related -----------------------------------------------------------------------------------------------------


def test_related_ranking_with_and_without_covisit() -> None:
    paths = {"/blog/a": "a", "/blog/b": "b", "/blog/c": "c"}
    cov = rl.covisit_matrix([{"landing_page": "https://jithendar.com/blog/a/", "page_path": "/blog/c", "views": 90}, {"landing_page": "/blog/a", "page_path": "/blog/b", "views": 10}], paths)
    assert cov[("a", "c")] == cov[("c", "a")] and cov[("a", "c")] > cov[("a", "b")]
    sim = [("b", "/blog/b", 0.80), ("c", "/blog/c", 0.75)]
    with_c = rl.rank_related("a", sim, cov, {}, {})
    assert [r["related_id"] for r in with_c] == ["c", "b"] and "covisit" in with_c[0]["components"]
    without = rl.rank_related("a", sim, {}, {}, {})
    assert [r["related_id"] for r in without] == ["b", "c"] and "covisit" not in without[0]["components"]
    assert rl.experiment_arm("00000000-0000-4000-8000-00000000000a") == "model" and rl.experiment_arm("00000000-0000-4000-8000-00000000000b") == "rule"


# --- registry and the flow ------------------------------------------------------------------------------------------


async def test_register_activation_review_and_fallback() -> None:
    s = MemoryMlStore()
    r1 = await tr.register(s, "decay", n=5, model_metrics={}, rule_metrics={}, beats=True, needs_review=True)
    assert r1["version"] == "v1" and not r1["active"] and r1["status"] == "needs_review"
    s.models[-1]["reviewed_by"] = "owner"  # the Models page approval
    r2 = await tr.register(s, "decay", n=5, model_metrics={}, rule_metrics={}, beats=True, needs_review=True)
    assert r2["active"] and r2["version"] == "v2"  # the review carries over to a retrain that still wins
    before = metrics.ML_TRAIN_RUNS.labels(model="decay", status="fallback_to_rule")._value.get()
    r3 = await tr.register(s, "decay", n=5, model_metrics={}, rule_metrics={}, beats=False)
    assert not r3["active"] and r3["run_status"] == "fallback_to_rule"
    assert await s.active_model("decay") is None
    assert metrics.ML_TRAIN_RUNS.labels(model="decay", status="fallback_to_rule")._value.get() == before + 1


def _store_with_data() -> MemoryMlStore:
    s = MemoryMlStore(gsc_end=END)
    for page, kind, seed in [("https://jithendar.com/blog/a", "drop", 7), ("https://jithendar.com/blog/b", "stable", 8)]:
        y = dc.synthetic_series(kind, seed=seed, n=200)
        s.daily += [{"page": page, "date": END - timedelta(days=199 - i), "clicks": float(v), "impressions": 500.0} for i, v in enumerate(y)]
    rows, _v, _l = _cluster_fixture()
    s.queries = rows
    _x, y, q = _intent_data(it.MIN_TRAIN // 5)
    s.intents = list(zip(q, y, strict=True))
    s.article_rows = [{"id": f"00000000-0000-4000-8000-00000000000{i}", "path": f"/blog/{i}", "category": "k8s"} for i in range(4)]
    return s


async def test_seo_ml_flow_runs_every_model_on_the_memory_store(llm, web) -> None:
    from app.index import Hit, MemoryRetriever
    from app.main import memory_container
    from tests.conftest import settings

    hits = [Hit(f"00000000-0000-4000-8000-00000000000{i}", f"T{i}", f"/blog/{i}", "H", "h", f"text {i} kubernetes", 0.8) for i in range(4)]
    c = memory_container(settings(), llm=llm, web=web, retriever=MemoryRetriever(hits))
    store = _store_with_data()
    c.deps.extra["ml_store"] = store
    r = await c.runner.kickoff("seo_ml_flow", {}, triggered_by="manual")
    await c.runner.wait(r["run_id"])
    run = await c.store.get(r["run_id"])
    assert run["status"] == "succeeded", run.get("error")
    kinds = {m["kind"] for m in store.models}
    assert kinds == {"decay", "query_clusters", "intent", "priority", "related"}
    decay = {o["page"]: o for o in store.outputs["seo_ml_decay_signals"]}
    assert decay["https://jithendar.com/blog/a"]["decaying"] and not decay["https://jithendar.com/blog/b"]["decaying"]
    assert store.outputs["seo_ml_query_clusters"] and store.outputs["seo_ml_intent_predictions"] and store.outputs["seo_ml_related_articles"]
    assert next(m for m in store.models if m["kind"] == "priority")["status"] == "collecting_data"
    assert next(m for m in store.models if m["kind"] == "related")["status"] == "experiment_running"
    assert store.rag_evals  # the live eval ran against the retriever
    assert len(await store.labels("intent_check")) <= it.SPOT_CHECKS


async def test_seo_ml_flow_subset_and_failure(llm, web) -> None:
    from app.main import memory_container
    from tests.conftest import settings

    c = memory_container(settings(), llm=llm, web=web)
    store = _store_with_data()

    async def boom() -> None:
        raise RuntimeError("db down")

    store.outcomes = boom  # type: ignore[method-assign]
    c.deps.extra["ml_store"] = store
    r = await c.runner.kickoff("seo_ml_flow", {"models": ["decay", "priority"]}, triggered_by="manual")
    await c.runner.wait(r["run_id"])
    run = await c.store.get(r["run_id"])
    assert run["status"] == "failed" and "priority" in (run.get("error") or "")
    assert {m["kind"] for m in store.models} == {"decay"}  # decay still wrote its result


def test_link_ranking_uses_related_scores_only_when_given() -> None:
    from app.flows.maintenance import combine

    similar = [("b", "/blog/b", 0.9), ("c", "/blog/c", 0.8)]
    rule = combine(similar, set(), {})
    assert [c["path"] for c in rule] == ["/blog/b", "/blog/c"] and "related" not in rule[0]
    with_model = combine(similar, set(), {}, {"c": 1.0, "b": 0.0})
    assert [c["path"] for c in with_model] == ["/blog/c", "/blog/b"] and with_model[0]["related"] == 1.0
