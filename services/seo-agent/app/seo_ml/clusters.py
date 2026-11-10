"""3.2 Query clustering with embeddings (docs/seo/ML.md "Query clusters").

Search Console queries are embedded with the service's embedding model (cached by normalised query text) and clustered
with scikit-learn's HDBSCAN (≥ 1.3, no new library). Each cluster is named after its highest-impression query; HDBSCAN
noise points become singleton clusters. The rule it competes with is the web app's token-set clustering
(keywords.ts clusterQueries), ported here exactly so both are scored on the same labelled sample.

Evaluation: the owner-confirmed labelled sample (Models → Labelling; Claude only suggests groupings): adjusted Rand
index (the deciding metric) and purity (may be at most 0.05 lower: purity alone rewards over-splitting), with inverse
purity reported, model vs token-set, on ≥ MIN_LABELLED confirmed queries.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from typing import Any

import numpy as np

MIN_LABELLED = 100
SAMPLE_SIZE = 200
STOP = frozenset("a an and are as at be by can do does for from how i in is it my of on or the to what when where which why with you your vs".split())


def normalize(q: str) -> str:
    return " ".join(q.lower().split())


# --- the rule: token-set clustering, as in services/www/src/lib/seo-intel/keywords.ts ------------------------------


def _stem(t: str) -> str:
    if len(t) > 5 and t.endswith("ing"):
        return t[:-3]
    if len(t) > 4 and t.endswith("s") and not t.endswith("ss"):
        return t[:-1]
    return t


def tokens(q: str) -> set[str]:
    return {_stem(t) for t in re.findall(r"[a-z0-9][a-z0-9+#.-]*", q.lower()) if t not in STOP}


def similarity(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    i = len(a & b)
    return i / min(len(a), len(b)) * math.sqrt(i / max(len(a), len(b)))


def token_set_clusters(rows: list[dict[str, Any]], threshold: float = 0.5) -> dict[str, tuple[int, str]]:
    """Greedy by impressions: a query joins the most similar existing seed above the threshold (keywords.ts)."""
    ordered = sorted(rows, key=lambda r: (-float(r["impressions"]), r["query"]))
    seeds: list[tuple[int, str, set[str]]] = []
    out: dict[str, tuple[int, str]] = {}
    for r in ordered:
        t = tokens(r["query"])
        best: tuple[float, tuple[int, str, set[str]]] | None = None
        for seed in seeds:
            s = similarity(t, seed[2])
            if s >= threshold and (best is None or s > best[0]):
                best = (s, seed)
        if best:
            out[r["query"]] = (best[1][0], best[1][1])
        else:
            seed = (len(seeds) + 1, r["query"], t)
            seeds.append(seed)
            out[r["query"]] = (seed[0], seed[1])
    return out


# --- the model ---------------------------------------------------------------------------------------------------------


def hdbscan_clusters(rows: list[dict[str, Any]], vectors: np.ndarray, min_cluster_size: int = 3, min_samples: int | None = 2) -> dict[str, tuple[int, str]]:
    """rows[i] ↔ vectors[i] (L2-normalised, so euclidean ranks like cosine). Noise → singletons."""
    from sklearn.cluster import HDBSCAN

    if len(rows) < max(3, min_cluster_size):
        return {r["query"]: (i + 1, r["query"]) for i, r in enumerate(rows)}
    labels = HDBSCAN(min_cluster_size=min_cluster_size, min_samples=min_samples, metric="euclidean", cluster_selection_method="eom", copy=True).fit_predict(vectors)
    groups: dict[int, list[int]] = {}
    for i, lab in enumerate(labels):
        groups.setdefault(int(lab), []).append(i)
    out: dict[str, tuple[int, str]] = {}
    next_id = 1
    # stable ids: clusters ordered by total impressions, then noise singletons by impressions
    real = sorted((g for k, g in groups.items() if k >= 0), key=lambda g: -sum(float(rows[i]["impressions"]) for i in g))
    for g in real:
        top = max(g, key=lambda i: (float(rows[i]["impressions"]), -len(rows[i]["query"])))
        for i in g:
            out[rows[i]["query"]] = (next_id, rows[top]["query"])
        next_id += 1
    for i in sorted(groups.get(-1, []), key=lambda i: -float(rows[i]["impressions"])):
        out[rows[i]["query"]] = (next_id, rows[i]["query"])
        next_id += 1
    return out


# --- evaluation ----------------------------------------------------------------------------------------------------------


def purity(pred: list[int], truth: list[str]) -> float:
    by: dict[int, Counter[str]] = {}
    for p, t in zip(pred, truth, strict=True):
        by.setdefault(p, Counter())[t] += 1
    return sum(c.most_common(1)[0][1] for c in by.values()) / max(1, len(pred))


def inverse_purity(pred: list[int], truth: list[str]) -> float:
    """How whole each true group stays (low when a method splits groups apart)."""
    by: dict[str, Counter[int]] = {}
    for p, t in zip(pred, truth, strict=True):
        by.setdefault(t, Counter())[p] += 1
    return sum(c.most_common(1)[0][1] for c in by.values()) / max(1, len(pred))


def evaluate(labels: dict[str, str], model: dict[str, tuple[int, str]], rule: dict[str, tuple[int, str]]) -> dict[str, Any]:
    """labels: query → owner-confirmed group name. Only queries present in all three are scored."""
    from sklearn.metrics import adjusted_rand_score

    qs = [q for q in labels if q in model and q in rule]
    if len(qs) < 2:
        return {"n": len(qs)}
    truth = [labels[q] for q in qs]
    m = [model[q][0] for q in qs]
    r = [rule[q][0] for q in qs]
    return {
        "n": len(qs),
        "model": {"ari": round(float(adjusted_rand_score(truth, m)), 4), "purity": round(purity(m, truth), 4), "inverse_purity": round(inverse_purity(m, truth), 4), "clusters": len(set(m))},
        "rule": {"ari": round(float(adjusted_rand_score(truth, r)), 4), "purity": round(purity(r, truth), 4), "inverse_purity": round(inverse_purity(r, truth), 4), "clusters": len(set(r))},
        "true_groups": len(set(truth)),
    }


PURITY_TOLERANCE = 0.05


def beats_rule(ev: dict[str, Any]) -> bool:
    """ARI is the deciding metric; purity may not drop by more than PURITY_TOLERANCE. Purity alone rewards
    over-splitting (all singletons = purity 1), which is what token-set clustering tends to do, so it can't be the gate;
    inverse purity is reported next to it to show that."""
    if ev.get("n", 0) < MIN_LABELLED or "model" not in ev:
        return False
    return ev["model"]["ari"] > ev["rule"]["ari"] and ev["model"]["purity"] >= ev["rule"]["purity"] - PURITY_TOLERANCE


def sample_for_labelling(rows: list[dict[str, Any]], n: int = SAMPLE_SIZE, seed: int = 7) -> list[str]:
    """Half the top queries by impressions, half a random sample of the rest (so the long tail is labelled too)."""
    ordered = sorted(rows, key=lambda r: -float(r["impressions"]))
    head = [r["query"] for r in ordered[: n // 2]]
    rest = [r["query"] for r in ordered[n // 2 :]]
    rng = np.random.default_rng(seed)
    tail = [rest[i] for i in rng.permutation(len(rest))[: n - len(head)]] if rest else []
    return head + tail
