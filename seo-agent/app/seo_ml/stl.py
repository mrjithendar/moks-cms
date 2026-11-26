"""STL: Seasonal-Trend decomposition using LOESS (Cleveland, Cleveland, McRae & Terpenning, 1990), in numpy.

Why not statsmodels: it would add statsmodels + pandas + patsy (~100 MB installed) to the seo-agent image for one
function; numpy (already installed) does the job (docs/seo/DECISIONS.md D-75). This follows the paper's algorithm:

  inner loop (n_i passes): detrend → cycle-subseries LOESS (n_s) → low-pass filter of the result (moving averages
  n_p, n_p, 3, then LOESS n_l) → seasonal = smoothed cycle-subseries − low-pass → deseasonalise → trend LOESS (n_t)
  outer loop (n_o passes): bisquare robustness weights from the residuals, so outliers (a holiday dip, a one-day
  spike) don't bend the trend.

LOESS here is local linear regression with tricube weights evaluated at every point (degree 1, as in the paper's
defaults for the seasonal and trend smoothers). O(n · q) per smoother; for ≤ 2 years of daily data that is fast.
Multiple seasonalities (weekly + yearly) are handled by applying STL for the yearly period to the series after the
weekly component has been removed (the usual MSTL-style iteration, one pass).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


def _odd(n: int) -> int:
    n = int(n)
    return n if n % 2 else n + 1


def _loess_even(y: np.ndarray, span: int, w_rob: np.ndarray, at: np.ndarray) -> np.ndarray:
    """loess() for x = 0..n−1 (daily series, cycle-subseries): the q nearest neighbours of a point are a contiguous
    window, so every fit is computed at once on an (len(at), q) index matrix instead of a Python loop."""
    n = len(y)
    q = max(2, min(int(span), n))
    centre = np.rint(at).astype(int)
    lo = np.clip(centre - q // 2, 0, n - q)
    idx = lo[:, None] + np.arange(q)[None, :]
    xs = idx.astype(float)
    d = np.abs(xs - at[:, None])
    h = d.max(axis=1)
    if span > n:
        h = h * span / n
    h = np.maximum(h, 1e-9)
    u = np.clip(d / h[:, None], 0, 1)
    w = (1 - u**3) ** 3 * w_rob[idx]
    sw = w.sum(axis=1)
    ok = sw > 1e-12
    sw_safe = np.where(ok, sw, 1.0)
    xm = (w * xs).sum(axis=1) / sw_safe
    yv = y[idx]
    ym = (w * yv).sum(axis=1) / sw_safe
    var = (w * (xs - xm[:, None]) ** 2).sum(axis=1)
    cov = (w * (xs - xm[:, None]) * (yv - ym[:, None])).sum(axis=1)
    b = np.where(var > 1e-12, cov / np.where(var > 1e-12, var, 1.0), 0.0)
    out = ym + b * (at - xm)
    return np.where(ok, out, yv.mean(axis=1))


def loess(y: np.ndarray, span: int, weights: np.ndarray | None = None, x: np.ndarray | None = None, at: np.ndarray | None = None) -> np.ndarray:
    """Local linear fit with tricube weights over the `span` nearest x values; evaluated at `at` (default x).
    Evenly spaced x (x=None) takes the vectorised path; arbitrary x the reference loop."""
    n = len(y)
    if x is None:
        return _loess_even(np.asarray(y, dtype=float), span, np.ones(n) if weights is None else np.asarray(weights, dtype=float), np.arange(n, dtype=float) if at is None else np.asarray(at, dtype=float))
    x = np.arange(n, dtype=float) if x is None else np.asarray(x, dtype=float)
    at = x if at is None else np.asarray(at, dtype=float)
    w_rob = np.ones(n) if weights is None else weights
    q = max(2, min(int(span), n))
    out = np.empty(len(at))
    for i, x0 in enumerate(at):
        d = np.abs(x - x0)
        idx = np.argpartition(d, q - 1)[:q] if q < n else np.arange(n)
        h = d[idx].max()
        if span > n:  # the paper widens the bandwidth when q > n
            h = h * span / n
        h = max(h, 1e-9)
        u = np.clip(d[idx] / h, 0, 1)
        w = (1 - u**3) ** 3 * w_rob[idx]
        sw = w.sum()
        if sw <= 1e-12:
            out[i] = float(np.mean(y[idx]))
            continue
        xm = (w * x[idx]).sum() / sw
        ym = (w * y[idx]).sum() / sw
        var = (w * (x[idx] - xm) ** 2).sum()
        b = (w * (x[idx] - xm) * (y[idx] - ym)).sum() / var if var > 1e-12 else 0.0
        out[i] = ym + b * (x0 - xm)
    return out


def _moving_average(y: np.ndarray, k: int) -> np.ndarray:
    c = np.cumsum(np.insert(y, 0, 0.0))
    return (c[k:] - c[:-k]) / k


@dataclass
class Decomposition:
    observed: np.ndarray
    trend: np.ndarray
    seasonal: np.ndarray
    resid: np.ndarray
    weights: np.ndarray


def stl(y: np.ndarray, period: int, *, seasonal: int = 7, trend: int | None = None, low_pass: int | None = None, inner: int = 2, outer: int = 2) -> Decomposition:
    """STL with the paper's parameter defaults: n_s = `seasonal` (odd, ≥ 7), n_l = next odd ≥ period,
    n_t = next odd ≥ 1.5·period / (1 − 1.5/n_s)."""
    y = np.asarray(y, dtype=float)
    n = len(y)
    if n < 2 * period:
        raise ValueError(f"STL needs at least two full periods ({2 * period} points), got {n}")
    ns = _odd(max(7, seasonal))
    nl = _odd(low_pass or period + (period % 2 == 0))
    nt = _odd(trend or int(np.ceil(1.5 * period / (1 - 1.5 / ns))))
    trend_c = np.zeros(n)
    season = np.zeros(n)
    rob = np.ones(n)
    for o in range(outer + 1):
        for _ in range(inner):
            detr = y - trend_c
            # cycle-subseries smoothing, extended by one period at each end (needed by the low-pass filter)
            cyc = np.zeros(n + 2 * period)
            for k in range(period):
                idx = np.arange(k, n, period)
                ext = np.arange(-1, len(idx) + 1, dtype=float)
                sm = loess(detr[idx], ns, rob[idx], at=ext)  # positions 0..m−1, evenly spaced
                cyc[np.arange(k, n + 2 * period, period)[: len(ext)]] = sm
            lp = _moving_average(_moving_average(_moving_average(cyc, period), period), 3)
            lp = loess(lp, nl)
            season = cyc[period : period + n] - lp
            trend_c = loess(y - season, nt, rob)
        if o == outer:
            break
        r = np.abs(y - season - trend_c)
        h = 6 * np.median(r)
        u = np.clip(r / max(h, 1e-12), 0, 1)
        rob = (1 - u**2) ** 2
    return Decomposition(y, trend_c, season, y - trend_c - season, rob)


def mstl(y: np.ndarray, periods: list[int]) -> Decomposition:
    """Weekly, then yearly (when there is enough data): each STL runs on the series without the other seasonal parts."""
    y = np.asarray(y, dtype=float)
    seasonals = {p: np.zeros(len(y)) for p in periods}
    last: Decomposition | None = None
    for p in periods:
        others = sum((s for q, s in seasonals.items() if q != p), np.zeros(len(y)))
        d = stl(y - others, p, seasonal=7 if p <= 7 else 13)
        seasonals[p] = d.seasonal
        last = d
    assert last is not None
    total_season = sum(seasonals.values(), np.zeros(len(y)))
    trend = last.trend
    return Decomposition(y, trend, total_season, y - trend - total_season, last.weights)
