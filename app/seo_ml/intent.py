"""3.3 Cheap intent classifier, distilled from Claude Haiku's labels (docs/seo/ML.md "Intent").

Training data: `seo_query_intents` rows labelled by Haiku with the CURRENT intent prompt (`INTENT_PROMPT_VERSION`,
mirrored from moks-cms/src/lib/seo-intel/keywords.ts; a contract test keeps them equal), plus the owner's
corrections from the spot-check tasks (human labels win). Features: the query embedding ⊕ simple lexical features
("how to", "vs", error words, version patterns, …). Model: multinomial logistic regression (scikit-learn,
class_weight=balanced), stored as numpy arrays (no pickle), like the news desk's topic classifier.

Use: the web app's keyword refresh takes the model's intent when its confidence ≥ the stored threshold, and asks Haiku
otherwise; Haiku's answers become new training data. Activation: macro-F1 ≥ 0.85 against held-out Haiku labels (mean
over stratified repeated K-fold) AND the owner has spot-checked 50 model/Haiku disagreements (fewer if fewer exist) on
the Labelling page. The confidence threshold is tuned on a calibration split carved out of each training fold, never on
the fold whose accuracy is reported.
"""

from __future__ import annotations

import io
import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

import numpy as np

INTENT_PROMPT_VERSION = "seo-intent-v1"
INTENTS = ("informational", "navigational", "commercial", "troubleshooting", "comparison")
# ≈ 60 labels per class over five classes: with fewer, a 5-fold evaluation scores each class on ~10 queries per fold
# and macro-F1 moves by several points between seeds (an earlier MIN_TRAIN of 60 left ~12 test queries in total).
MIN_TRAIN = 300
MIN_F1 = 0.85
SPOT_CHECKS = 50
DEFAULT_THRESHOLD = 0.7
# Evaluation: stratified K-fold repeated CV_REPEATS times. Inside each training fold a stratified CALIBRATION_SHARE is
# held back to tune the confidence threshold, so the threshold is never tuned on the fold its accuracy is reported on.
CV_FOLDS = 5
CV_REPEATS = 2
CALIBRATION_SHARE = 0.25
TARGET_ACCURACY = 0.9  # the threshold is the lowest confidence at which calibration accuracy (at or above it) is ≥ this

LEXICAL = [
    ("how_to", re.compile(r"\bhow (to|do|does|can)\b")),
    ("what_is", re.compile(r"\b(what|why) (is|are|does)\b")),
    ("vs", re.compile(r"\b(vs\.?|versus|or|compare|comparison|difference|alternatives?)\b")),
    ("error", re.compile(r"\b(error|errors|fix|failed|failing|fails|not working|issue|crash\w*|timeout|denied|refused|cannot|can'?t|stuck|pending|oomkilled|crashloopbackoff|exit code)\b")),
    ("version", re.compile(r"\bv?\d+\.\d+(\.\d+)?\b")),
    ("commercial", re.compile(r"\b(best|top \d+|price|pricing|cost|cheap\w*|review|reviews|buy|course|courses|certification|hire)\b")),
    ("nav", re.compile(r"\b(login|github|docs?|documentation|download|official|site|portal|dashboard)\b")),
    ("tutorial", re.compile(r"\b(tutorial|guide|example|examples|setup|install\w*|configure|step by step)\b")),
]


def lexical(q: str) -> np.ndarray:
    ql = q.lower()
    words = len(ql.split())
    return np.asarray([1.0 if rx.search(ql) else 0.0 for _, rx in LEXICAL] + [min(words, 12) / 12, 1.0 if ql.endswith("?") else 0.0], dtype=np.float32)


def featurize(embedding: list[float] | np.ndarray, q: str) -> np.ndarray:
    return np.concatenate([np.asarray(embedding, dtype=np.float32), lexical(q)])


@dataclass
class IntentModel:
    version: str
    classes: list[str]
    coef: np.ndarray
    intercept: np.ndarray
    threshold: float = DEFAULT_THRESHOLD
    metrics: dict[str, Any] = field(default_factory=dict)

    def proba(self, x: np.ndarray) -> np.ndarray:
        z = x @ self.coef.T + self.intercept
        z = z - z.max(axis=1, keepdims=True)
        e = np.exp(z)
        return e / e.sum(axis=1, keepdims=True)

    def predict(self, x: np.ndarray) -> list[tuple[str, float]]:
        p = self.proba(x)
        return [(self.classes[int(i)], round(float(p[k, i]), 4)) for k, i in enumerate(p.argmax(axis=1))]

    def to_bytes(self) -> bytes:
        buf = io.BytesIO()
        np.savez_compressed(buf, coef=self.coef, intercept=self.intercept, classes=np.asarray(self.classes), threshold=np.asarray([self.threshold]))
        return buf.getvalue()

    @classmethod
    def from_bytes(cls, version: str, data: bytes) -> IntentModel:
        z = np.load(io.BytesIO(data), allow_pickle=False)
        return cls(version, [str(c) for c in z["classes"]], z["coef"], z["intercept"], float(z["threshold"][0]))


def tune_threshold(conf: list[float], correct: list[bool], target: float = TARGET_ACCURACY) -> float:
    """The lowest confidence at which the accuracy of predictions at or above it is ≥ target, within [0.5, 0.95]."""
    thr = 0.95
    hits = 0
    for k, (c, ok) in enumerate(sorted(zip(conf, correct, strict=True), key=lambda z: -z[0]), start=1):
        hits += int(ok)
        if hits / k >= target:
            thr = c
    return round(float(min(0.95, max(0.5, thr))), 3)


def _stratify(y: list[str], idx: np.ndarray, need: int) -> list[str] | None:
    labels = [y[i] for i in idx]
    return labels if min(labels.count(c) for c in set(labels)) >= need else None


def split_calibration(y: list[str], train_idx: np.ndarray, seed: int) -> tuple[np.ndarray, np.ndarray]:
    """A training fold → (fit indices, calibration indices), stratified when every class has ≥ 2 rows."""
    from sklearn.model_selection import train_test_split

    fit, cal = train_test_split(train_idx, test_size=CALIBRATION_SHARE, random_state=seed, stratify=_stratify(y, train_idx, 2))
    return np.asarray(fit), np.asarray(cal)


def cv_splits(y: list[str], seed: int = 7) -> Iterator[tuple[int, np.ndarray, np.ndarray, np.ndarray]]:
    """Stratified repeated K-fold: (repeat, fit, calibration, test) index arrays, pairwise disjoint."""
    from sklearn.model_selection import RepeatedKFold, RepeatedStratifiedKFold

    idx = np.arange(len(y))
    strat = _stratify(y, idx, CV_FOLDS) is not None
    rkf = RepeatedStratifiedKFold(n_splits=CV_FOLDS, n_repeats=CV_REPEATS, random_state=seed) if strat else RepeatedKFold(n_splits=CV_FOLDS, n_repeats=CV_REPEATS, random_state=seed)
    for k, (tr, te) in enumerate(rkf.split(idx.reshape(-1, 1), y if strat else None)):
        fit, cal = split_calibration(y, tr, seed + k)
        yield k // CV_FOLDS, fit, cal, te


def fit(x: np.ndarray, y: list[str], idx: np.ndarray, version: str, seed: int) -> IntentModel:
    from sklearn.linear_model import LogisticRegression

    clf = LogisticRegression(max_iter=2000, class_weight="balanced", C=2.0, random_state=seed)
    clf.fit(x[idx], [y[i] for i in idx])
    return IntentModel(version, [str(c) for c in clf.classes_], clf.coef_.astype(np.float64), clf.intercept_.astype(np.float64))


def calibrate(model: IntentModel, x: np.ndarray, y: list[str], cal_idx: np.ndarray) -> None:
    """Sets the model's threshold from the calibration rows only."""
    pred = model.predict(x[cal_idx])
    model.threshold = tune_threshold([c for _, c in pred], [p == y[i] for (p, _), i in zip(pred, cal_idx, strict=True)])


def train(x: np.ndarray, y: list[str], version: str, seed: int = 7) -> tuple[IntentModel | None, dict[str, Any], list[tuple[int, str, float]]]:
    """Returns (model, metrics, out-of-fold predictions of the first repeat as (index, intent, confidence)).

    Metrics: stratified K-fold repeated CV_REPEATS times. In each fold the model is fitted on part of the training fold,
    its threshold is tuned on the rest of the training fold (calibration), and macro-F1, the share of queries it would
    answer without Claude and its accuracy on those are measured on the test fold. The stored model is fitted the same
    way on all labels (fit + calibration split), so its threshold, too, comes from rows it wasn't fitted on."""
    from sklearn.metrics import f1_score

    if len(y) < MIN_TRAIN or len(set(y)) < 2:
        return None, {"n": len(y), "status": "collecting_data", "needed": MIN_TRAIN}, []
    classes = sorted(set(y))
    f1s: list[float] = []
    per_class: list[np.ndarray] = []
    thresholds: list[float] = []
    confident = confident_ok = tested = 0
    oof: list[tuple[int, str, float]] = []
    for rep, fit_idx, cal_idx, te in cv_splits(y, seed):
        m = fit(x, y, fit_idx, version, seed)
        calibrate(m, x, y, cal_idx)
        pred = m.predict(x[te])
        truth = [y[i] for i in te]
        labels = [p for p, _ in pred]
        f1s.append(float(f1_score(truth, labels, average="macro", labels=classes, zero_division=0)))
        per_class.append(np.asarray(f1_score(truth, labels, average=None, labels=classes, zero_division=0), dtype=float))
        thresholds.append(m.threshold)
        tested += len(te)
        for (p, c), t in zip(pred, truth, strict=True):
            if c >= m.threshold:
                confident += 1
                confident_ok += int(p == t)
        if rep == 0:
            oof += [(int(i), p, c) for i, (p, c) in zip(te, pred, strict=True)]
    fit_idx, cal_idx = split_calibration(y, np.arange(len(y)), seed)
    model = fit(x, y, fit_idx, version, seed)
    calibrate(model, x, y, cal_idx)
    metrics = {
        "n": len(y),
        "cv": f"stratified {CV_FOLDS}-fold × {CV_REPEATS}; threshold tuned on a {int(CALIBRATION_SHARE * 100)} % calibration split of each training fold",
        "train": len(fit_idx),
        "calibration": len(cal_idx),
        "test": tested // CV_REPEATS,
        "macro_f1": round(float(np.mean(f1s)), 4),
        "macro_f1_std": round(float(np.std(f1s)), 4),
        "per_class": {c: round(float(f), 4) for c, f in zip(classes, np.mean(per_class, axis=0), strict=True)},
        "threshold": model.threshold,
        "threshold_cv_mean": round(float(np.mean(thresholds)), 3),
        "share_confident": round(confident / max(1, tested), 4),
        "accuracy_when_confident": round(confident_ok / max(1, confident), 4),
    }
    model.metrics = metrics
    return model, metrics, sorted(oof)


def rule_intent(q: str, brand: str = "jithendar") -> str:
    """The web app's rules fallback (keywords.ts intentByRules), for the baseline row on the Models page."""
    ql = q.lower()
    if (brand and brand in ql) or re.search(r"\b(login|github|docs?|documentation|download|official|site|portal|dashboard)\b", ql):
        return "navigational"
    if re.search(r"\b(vs\.?|versus|compare|comparison|alternatives?|difference|differences|better than)\b|\bor\b.+\?$", ql):
        return "comparison"
    if re.search(r"\b(error|errors|fix|fixing|failed|failing|fails|not working|issue|issues|troubleshoot\w*|debug\w*|crash\w*|timeout|denied|refused|cannot|can'?t|won'?t|stuck|pending|exit code|oomkilled|crashloopbackoff)\b", ql):
        return "troubleshooting"
    if re.search(r"\b(best|top \d+|price|pricing|cost|costs|cheap|cheapest|review|reviews|buy|course|courses|certification|tools?|services?|hire|consultant)\b", ql):
        return "commercial"
    return "informational"


def rule_macro_f1(queries: list[str], truth: list[str]) -> float:
    from sklearn.metrics import f1_score

    return round(float(f1_score(truth, [rule_intent(q) for q in queries], average="macro", labels=sorted(set(truth)), zero_division=0)), 4)


def ready_to_activate(metrics: dict[str, Any], spot_checked: int, disagreements: int) -> tuple[bool, str]:
    need = min(SPOT_CHECKS, disagreements)
    if metrics.get("macro_f1") is None:
        return False, "not trained"
    if metrics["macro_f1"] < MIN_F1:
        return False, f"macro-F1 {metrics['macro_f1']:.3f} < {MIN_F1}"
    if spot_checked < need:
        return False, f"spot-checked {spot_checked}/{need} disagreements"
    return True, "ok"
