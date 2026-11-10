"""3.3 Cheap intent classifier, distilled from Claude Haiku's labels (docs/seo/ML.md "Intent").

Training data: `seo_query_intents` rows labelled by Haiku with the CURRENT intent prompt (`INTENT_PROMPT_VERSION`,
mirrored from services/www/src/lib/seo-intel/keywords.ts; a contract test keeps them equal), plus the owner's
corrections from the spot-check tasks (human labels win). Features: the query embedding ⊕ simple lexical features
("how to", "vs", error words, version patterns, …). Model: multinomial logistic regression (scikit-learn,
class_weight=balanced), stored as numpy arrays (no pickle), like the news desk's topic classifier.

Use: the web app's keyword refresh takes the model's intent when its confidence ≥ the stored threshold, and asks Haiku
otherwise; Haiku's answers become new training data. Activation: macro-F1 ≥ 0.85 against held-out Haiku labels AND the
owner has spot-checked 50 model/Haiku disagreements (fewer if fewer exist) on the Labelling page.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from typing import Any

import numpy as np

INTENT_PROMPT_VERSION = "seo-intent-v1"
INTENTS = ("informational", "navigational", "commercial", "troubleshooting", "comparison")
MIN_TRAIN = 60
MIN_F1 = 0.85
SPOT_CHECKS = 50
DEFAULT_THRESHOLD = 0.7

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


def train(x: np.ndarray, y: list[str], version: str, seed: int = 7) -> tuple[IntentModel | None, dict[str, Any], list[int]]:
    """80/20 stratified split. Returns (model, metrics, held-out indices). Threshold = the lowest confidence at which the
    held-out accuracy of predictions at or above it is ≥ 0.9 (bounded to [0.5, 0.95]); the share of queries the model
    would answer without Claude at that threshold is reported."""
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import f1_score
    from sklearn.model_selection import train_test_split

    if len(y) < MIN_TRAIN or len(set(y)) < 2:
        return None, {"n": len(y), "status": "collecting_data", "needed": MIN_TRAIN}, []
    idx = np.arange(len(y))
    counts = {c: y.count(c) for c in set(y)}
    strat = y if min(counts.values()) >= 2 else None
    tr, te = train_test_split(idx, test_size=0.2, random_state=seed, stratify=strat)
    clf = LogisticRegression(max_iter=2000, class_weight="balanced", C=2.0, random_state=seed)
    clf.fit(x[tr], [y[i] for i in tr])
    classes = [str(c) for c in clf.classes_]
    model = IntentModel(version, classes, clf.coef_.astype(np.float64), clf.intercept_.astype(np.float64))
    pred = model.predict(x[te])
    truth = [y[i] for i in te]
    macro = float(f1_score(truth, [p for p, _ in pred], average="macro", labels=classes, zero_division=0))
    # threshold for "confident enough to skip Claude"
    pairs = sorted(((c, p == t) for (p, c), t in zip(pred, truth, strict=True)), key=lambda z: -z[0])
    thr = 0.95
    correct = 0
    for k, (c, ok) in enumerate(pairs, start=1):
        correct += int(ok)
        if correct / k >= 0.9:
            thr = c
    thr = float(min(0.95, max(0.5, thr)))
    model.threshold = round(thr, 3)
    confident = [(p, c, t) for (p, c), t in zip(pred, truth, strict=True) if c >= thr]
    metrics = {
        "n": len(y),
        "train": len(tr),
        "test": len(te),
        "macro_f1": round(macro, 4),
        "per_class": {c: round(float(f), 4) for c, f in zip(classes, f1_score(truth, [p for p, _ in pred], average=None, labels=classes, zero_division=0), strict=True)},
        "threshold": model.threshold,
        "share_confident": round(len(confident) / max(1, len(te)), 4),
        "accuracy_when_confident": round(sum(1 for p, _c, t in confident if p == t) / max(1, len(confident)), 4),
    }
    model.metrics = metrics
    return model, metrics, [int(i) for i in te]


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
