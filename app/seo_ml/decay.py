"""3.1 Seasonality-aware content decay (docs/seo/ML.md "Decay").

Per page with enough history (≥ 120 days of Search Console data and ≥ `min_impressions` in the last 28 days):
decompose daily clicks with STL (weekly; plus yearly with ≥ 2 years: the same weeks' deviation one year earlier, so a
recent decline can't be absorbed into the seasonal part) and flag decay when
  (a) the trend has fallen on each of the last `min_falling_days` (21) days,
  (b) the trend fell by more than `min_drop` (20 %) from its level before the decline, and
  (c) the residual-adjusted (deseasonalised, robustness-weighted) drop is beyond 2σ of the page's own history: σ = the
      standard deviation of 21-day means of the deseasonalised series over the history before the decline; the recent
      level weights each day by STL's bisquare robustness weight, so outlier days (a holiday dip) barely count, and
  (d) the last 7 days, deseasonalised, are also below the baseline by > 2σ (of 7-day means): STL's trend at the end of
      a series can't yet tell a dip that just ended from a decline; a recovered week can.
The rule it competes with is the web app's: clicks in the last 28 days vs the 28 before, ≥ 30 % lower, ≥ 20 clicks
(rules.ts decayRule; with a year-over-year check when that history exists).

Activation (train.run_decay): on a labelled synthetic benchmark (stable weekly pattern, holiday dips, zero-inflated
low-traffic pages, ranking gains that step the level up, sustained declines and ranking losses that step it down, all
with noise) the model must raise fewer false alarms on the negatives than the rule without missing more positives; on
the real back-test its alerts must stay within `MAX_ALERT_RATE_RATIO` × the rule's. The owner then reviews the real
back-test (status needs_review → approved on the Models page). A review covers one method and one `DecayConfig`
(`review_key`): it carries over to a retrain only while both are unchanged and the back-test's agreement with the rule
hasn't fallen more than `MAX_JACCARD_DROP` below the reviewed version's.
"""

from __future__ import annotations

import functools
import hashlib
import json
from dataclasses import asdict, dataclass, field
from datetime import date, timedelta
from typing import Any

import numpy as np

from .stl import loess, stl

METHOD = "stl-v1"
INSUFFICIENT = "insufficient_history"


@dataclass(frozen=True)
class DecayConfig:
    min_days: int = 120
    min_impressions: float = 100.0  # last 28 days
    min_falling_days: int = 21
    min_drop: float = 0.20
    sigma: float = 2.0
    trend_span: int = 45  # days; smoother than STL's weekly default so a 1–2-week dip can't drag the trend
    evidence_days: int = 120


DEFAULT_CONFIG = DecayConfig()

# Real back-test gates (train.run_decay). The synthetic benchmark runs the same fixed seeds every week, so on its own it
# would let every retrain through; these two read the site's own history.
# k: the model may alert on at most this multiple of the rule's page-windows, plus ALERT_SLACK page-windows so a site
# where the rule raises 0–1 alerts isn't decided by a single alert. The model exists to raise FEWER alerts than the rule;
# 1.5× leaves room for the declines the rule misses (on the benchmark the model catches about twice the rule's drops)
# without letting an alarm storm through.
MAX_ALERT_RATE_RATIO = 1.5
ALERT_SLACK = 2
# floor: a carried-over review needs the Jaccard agreement with the rule to stay within this much of the agreement the
# owner saw when reviewing. A larger fall means the model now flags different pages than the version that was reviewed.
MAX_JACCARD_DROP = 0.15


def config_hash(cfg: DecayConfig = DEFAULT_CONFIG) -> str:
    return hashlib.sha256(json.dumps(asdict(cfg), sort_keys=True).encode()).hexdigest()[:16]


def review_key(cfg: DecayConfig = DEFAULT_CONFIG) -> dict[str, str]:
    """What an owner's review approves: this method with this configuration. Anything else needs a new review."""
    return {"method": METHOD, "config_hash": config_hash(cfg)}


def alert_rate_ok(bt: dict[str, Any]) -> bool:
    """The model's back-test alerts stay within k × the rule's (+ slack)."""
    if not bt.get("page_windows"):
        return True  # nothing to back-test yet: the owner's review decides
    return int(bt["model_alerts"]) <= MAX_ALERT_RATE_RATIO * int(bt["rule_alerts"]) + ALERT_SLACK


def agreement_ok(bt: dict[str, Any], reviewed_bt: dict[str, Any] | None) -> bool:
    """The Jaccard agreement with the rule hasn't fallen more than MAX_JACCARD_DROP below the reviewed version's."""
    if reviewed_bt is None:
        return False  # no reviewed back-test to compare with: a fresh review is needed
    ref = reviewed_bt.get("agreement_jaccard")
    cur = bt.get("agreement_jaccard")
    if ref is None:
        return True  # neither flagged anything when reviewed: there was no agreement to keep
    if cur is None:
        return True  # neither flags anything now: nothing disagrees
    return float(cur) >= float(ref) - MAX_JACCARD_DROP


@dataclass
class Signal:
    page: str
    window_start: str
    window_end: str
    decaying: bool
    trend_slope: float | None
    drop_pct: float | None
    confidence: float | None
    method_version: str
    evidence: dict[str, Any] = field(default_factory=dict)

    def row(self) -> dict[str, Any]:
        return asdict(self)


def _falling_run(trend: np.ndarray) -> int:
    run = 0
    for i in range(len(trend) - 1, 0, -1):
        if trend[i] < trend[i - 1] - 1e-9:
            run += 1
        else:
            break
    return run


def detect(clicks: np.ndarray, impressions: np.ndarray | None, end: date, page: str, cfg: DecayConfig = DEFAULT_CONFIG) -> Signal:
    """clicks/impressions: one value per day ending at `end` (missing days = 0)."""
    clicks = np.asarray(clicks, dtype=float)
    n = len(clicks)
    start = end - timedelta(days=n - 1)
    imp28 = float(np.sum(impressions[-28:])) if impressions is not None and len(impressions) else float("inf")
    if n < cfg.min_days or imp28 < cfg.min_impressions:
        why = f"{n} days of history (needs {cfg.min_days})" if n < cfg.min_days else f"{imp28:.0f} impressions in 28 days (needs {cfg.min_impressions:.0f})"
        return Signal(page, start.isoformat(), end.isoformat(), False, None, None, None, INSUFFICIENT, {"reason": why})
    periods = [7, 365] if n >= 730 else [7]
    yearly = np.zeros(n)
    if n >= 730:
        # Yearly seasonality from data at least a year old only: last year's deviation of the (weekly-deseasonalised)
        # monthly level from that year's slow level, shifted by 364 days. With ~2 cycles a yearly STL's seasonal follows
        # whatever happened recently and absorbs the very decline we look for; last year's shape can't.
        weekly = stl(clicks, 7, trend=cfg.trend_span, outer=5).seasonal
        x = clicks - weekly
        dev = loess(x, 31) - loess(x, 365)
        yearly[364:] = dev[: n - 364]
    d = stl(clicks - yearly, 7, trend=cfg.trend_span, outer=5)
    d.seasonal = d.seasonal + yearly
    trend = d.trend
    run = _falling_run(trend)
    deseason = clicks - d.seasonal
    k = cfg.min_falling_days
    decline_start = max(0, n - 1 - run)
    peak = float(np.max(trend[max(0, decline_start - 7) : decline_start + 1])) if run else float(trend[-1])
    drop = (peak - float(trend[-1])) / peak if peak > 0 else 0.0
    # σ from the page's own history; with yearly adjustment, only the part that has it (the first year has no
    # year-earlier shape, so its seasonal swing would inflate σ)
    hist_from = 364 if n >= 730 else 0
    hist = deseason[hist_from : max(hist_from, decline_start)]
    means = np.convolve(hist, np.ones(k) / k, mode="valid") if len(hist) >= 2 * k else np.array([])
    sigma = float(np.std(means)) if len(means) > 2 else float("nan")
    base = float(np.mean(deseason[max(0, decline_start - 28) : decline_start])) if decline_start > 0 else float(np.mean(deseason[:k]))
    # residual-adjusted: the recent level is weighted by STL's robustness weights, so days STL treats as outliers (a
    # holiday dip, a one-day spike) count little; a sustained drop moves the trend, keeps small residuals, full weight.
    w = d.weights[-k:]
    recent = float(np.sum(w * deseason[-k:]) / np.sum(w)) if float(np.sum(w)) > 1e-9 else float(np.mean(deseason[-k:]))
    z = (base - recent) / sigma if sigma and np.isfinite(sigma) and sigma > 1e-9 else 0.0
    # (d) the latest week confirms it: STL's trend can't yet tell a dip that just ended from a decline (end effect), but
    # after a holiday the last days are back near the baseline, while a sustained decline keeps them low.
    means7 = np.convolve(hist, np.ones(7) / 7, mode="valid") if len(hist) >= 14 else np.array([])
    sigma7 = float(np.std(means7)) if len(means7) > 2 else float("nan")
    last7 = float(np.mean(deseason[-7:]))
    z7 = (base - last7) / sigma7 if sigma7 and np.isfinite(sigma7) and sigma7 > 1e-9 else 0.0
    slope = float(np.polyfit(np.arange(min(k, n)), trend[-min(k, n) :], 1)[0])
    decaying = run >= k and drop > cfg.min_drop and z > cfg.sigma and z7 > cfg.sigma
    conf = round(float(min(1.0, 0.5 + 0.125 * (z - cfg.sigma))) if decaying else max(0.0, min(0.49, z / (2 * cfg.sigma))), 3)
    ev_n = min(cfg.evidence_days, n)
    days = [(end - timedelta(days=ev_n - 1 - i)).isoformat() for i in range(ev_n)]
    evidence = {
        "dates": days,
        "actual": [round(float(v), 2) for v in clicks[-ev_n:]],
        "trend": [round(float(v), 2) for v in trend[-ev_n:]],
        "falling_days": run,
        "z": round(z, 2),
        "z_last7": round(z7, 2),
        "baseline": round(base, 2),
        "recent": round(recent, 2),
        "periods": periods,
    }
    return Signal(page, start.isoformat(), end.isoformat(), bool(decaying), round(slope, 4), round(drop, 4), conf, METHOD, evidence)


def rule_flags(clicks: np.ndarray, min_clicks: float = 20, drop_ratio: float = 0.3) -> bool:
    """The web app's rule, on the same series: last 28 days vs the 28 before (rules.ts decayRule, no YoY)."""
    if len(clicks) < 56:
        return False
    cur, prev = float(np.sum(clicks[-28:])), float(np.sum(clicks[-56:-28]))
    return prev >= min_clicks and (prev - cur) / prev >= drop_ratio


# --- Labelled synthetic benchmark (activation) and back-test -------------------------------------------------------


NEGATIVES = ("stable", "holiday", "sparse", "step_up")
POSITIVES = ("drop", "step")
KINDS = NEGATIVES + POSITIVES


def synthetic_series(kind: str, seed: int, n: int = 180, level: float = 30.0) -> np.ndarray:
    """Negatives (no decay):
      stable: weekly pattern + Poisson noise;
      holiday: stable + a 7–14-day dip of 50–70 % ending 5–25 days before the end (the rule's 28-day windows see it);
      sparse: a low-traffic page (2–6 clicks/day) with 20–50 % of its days at zero (zero-inflated, as GSC reports them);
      step_up: a ranking gain 60–120 days before the end steps the level up by 30–80 %, and it stays there.
    Positives (decay):
      drop: stable, then a sustained decline of 35–60 % over the last 30–50 days;
      step: a ranking loss 25–50 days before the end steps the level down by 35–60 % at once, and it stays down."""
    rng = np.random.default_rng(seed)
    t = np.arange(n)
    week = np.array([1.05, 1.12, 1.1, 1.06, 1.0, 0.62, 0.55])
    lvl = level * rng.uniform(0.7, 1.5)
    if kind == "sparse":
        lvl = rng.uniform(2.0, 6.0)
    base = lvl * week[t % 7]
    if kind == "step":
        base[n - int(rng.integers(25, 51)) :] *= 1 - rng.uniform(0.35, 0.6)
    elif kind == "step_up":
        base[n - int(rng.integers(60, 121)) :] *= 1 + rng.uniform(0.3, 0.8)
    elif kind == "sparse":
        y = rng.poisson(np.maximum(base, 0.1)).astype(float)
        y[rng.uniform(size=n) < rng.uniform(0.2, 0.5)] = 0.0
        return y
    if kind == "holiday":
        length = int(rng.integers(7, 15))
        stop = n - int(rng.integers(5, 26))
        base[stop - length : stop] *= 1 - rng.uniform(0.5, 0.7)
    elif kind == "drop":
        days = int(rng.integers(30, 51))
        depth = rng.uniform(0.35, 0.6)
        base[n - days :] *= np.linspace(1, 1 - depth, days)
    return np.maximum(0, rng.poisson(np.maximum(base, 0.1)).astype(float))


# The detector's conditions were designed while looking at seeds 0–2,999 (DESIGN_SEEDS) of the stable/holiday/drop
# kinds; sparse/step_up/step were added later without changing the detector. Activation is decided on seeds from
# HELD_OUT_SEEDS (kind k, series i: HELD_OUT_SEEDS + 1000·k + i), which were not looked at during design.
DESIGN_SEEDS = 0
HELD_OUT_SEEDS = 50_000
# kind index → seed offset; the first three keep their original offsets so earlier held-out results stay comparable
_SEED_OFFSET = {"stable": 0, "holiday": 1, "drop": 2, "sparse": 3, "step_up": 4, "step": 5}


@functools.cache
def benchmark(cfg: DecayConfig = DEFAULT_CONFIG, per_kind: int = 40, seed_base: int = HELD_OUT_SEEDS) -> dict[str, Any]:
    """Model vs rule on labelled synthetic series. Positives = sustained drops and step losses; the rest are noise."""
    end = date(2026, 1, 1)
    out: dict[str, dict[str, int]] = {"model": {}, "rule": {}}
    long_n = per_kind // 2  # plus 800-day series with a yearly wave (the yearly-seasonality path)
    total = per_kind + long_n
    for kind in KINDS:
        m = r = 0
        k = _SEED_OFFSET[kind]
        for i in range(total):
            n = 180 if i < per_kind else 800
            y = synthetic_series(kind, seed=seed_base + 1000 * k + i, n=n)
            if n == 800:
                y = y * (1 + 0.3 * np.sin(2 * np.pi * (np.arange(n) + 37 * i) / 365))
            m += int(detect(y, np.full(len(y), 1000.0), end, f"s{i}", cfg).decaying)
            r += int(rule_flags(y))
        out["model"][kind], out["rule"][kind] = m, r
    res: dict[str, Any] = {"per_kind": total, "short": per_kind, "long_800d": long_n, "seed_base": seed_base, "negatives": list(NEGATIVES), "positives": list(POSITIVES), "counts": out}
    for who in ("model", "rule"):
        c = out[who]
        fa = sum(c[k] for k in NEGATIVES)
        res[who] = {"false_alarms": fa, "false_alarm_rate": round(fa / (len(NEGATIVES) * total), 4), "drop_recall": round(sum(c[k] for k in POSITIVES) / (len(POSITIVES) * total), 4)}
    res["beats_rule"] = res["model"]["false_alarms"] < res["rule"]["false_alarms"] and res["model"]["drop_recall"] >= res["rule"]["drop_recall"]
    return res


def backtest(series: dict[str, tuple[np.ndarray, np.ndarray]], end: date, cfg: DecayConfig = DEFAULT_CONFIG, step_days: int = 14, windows: int = 8, max_pages: int = 80) -> dict[str, Any]:
    """Run model and rule on historical cut-offs (every `step_days`, the last `windows`): alert rates and agreement.
    Bounded to the `max_pages` pages with the most clicks so a weekly run stays a couple of minutes."""
    series = dict(sorted(series.items(), key=lambda kv: -float(kv[1][0].sum()))[:max_pages])
    m_alerts = r_alerts = both = either = evaluated = 0
    for w in range(windows):
        cut = w * step_days
        for _page, (clicks, imps) in series.items():
            c = clicks[: len(clicks) - cut] if cut else clicks
            i = imps[: len(imps) - cut] if cut else imps
            if len(c) < cfg.min_days:
                continue
            evaluated += 1
            m = detect(c, i, end - timedelta(days=cut), _page, cfg).decaying
            r = rule_flags(c)
            m_alerts += int(m)
            r_alerts += int(r)
            both += int(m and r)
            either += int(m or r)
    return {
        "page_windows": evaluated,
        "model_alert_rate": round(m_alerts / evaluated, 4) if evaluated else None,
        "rule_alert_rate": round(r_alerts / evaluated, 4) if evaluated else None,
        "agreement_jaccard": round(both / either, 4) if either else None,
        "pages": len(series),
        "model_alerts": m_alerts,
        "rule_alerts": r_alerts,
    }


def daily_series(rows: list[dict[str, Any]], end: date) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """rows: page, date, clicks, impressions (aggregated over device/country) → dense arrays ending at `end`."""
    by: dict[str, dict[date, tuple[float, float]]] = {}
    for r in rows:
        d = r["date"] if isinstance(r["date"], date) else date.fromisoformat(str(r["date"]))
        by.setdefault(r["page"], {})[d] = (float(r["clicks"]), float(r["impressions"]))
    out: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for page, m in by.items():
        first = min(m)
        n = (end - first).days + 1
        c, i = np.zeros(n), np.zeros(n)
        for d, (cl, im) in m.items():
            k = (d - first).days
            if 0 <= k < n:
                c[k], i[k] = cl, im
        out[page] = (c, i)
    return out
