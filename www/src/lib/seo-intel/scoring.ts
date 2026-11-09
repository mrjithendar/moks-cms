import type { Weights } from "./settings";

/**
 * Priority scoring (docs/seo/SCORING.md). Each input is normalised to 0–1 by the rule that produced it; a missing
 * input (no data) is excluded and the remaining weights are renormalised, and that is recorded on the
 * recommendation. Score = Σ wᵢ·xᵢ / Σ wᵢ over the inputs present. Bands come from the configurable thresholds.
 */
export const INPUTS = ["searchOpportunity", "rankingOpportunity", "relevance", "qualityGap", "trend", "effort"] as const;
export type InputKey = (typeof INPUTS)[number];
export type ScoreInputs = Partial<Record<InputKey, number>>;

export type Score = {
  score: number;
  band: "high" | "medium" | "low";
  inputs: ScoreInputs;
  used: InputKey[];
  missing: InputKey[];
  /** True when at least one weighted input was missing and the others were scaled up. */
  renormalized: boolean;
  weights: Weights;
};

export const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** log-scaled volume: 0 at 0, 1 at `max` (the largest value in the same analysis run). */
export function logNorm(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return clamp01(Math.log10(1 + value) / Math.log10(1 + max));
}

export function scoreOf(inputs: ScoreInputs, weights: Weights, bands: { high: number; medium: number }): Score {
  const used: InputKey[] = [];
  const missing: InputKey[] = [];
  let num = 0;
  let den = 0;
  for (const k of INPUTS) {
    const w = weights[k];
    const v = inputs[k];
    if (v === undefined || v === null || !Number.isFinite(v)) {
      if (w > 0) missing.push(k);
      continue;
    }
    used.push(k);
    num += w * clamp01(v);
    den += w;
  }
  const score = den > 0 ? num / den : 0;
  const rounded = Math.round(score * 1000) / 1000;
  return { score: rounded, band: rounded >= bands.high ? "high" : rounded >= bands.medium ? "medium" : "low", inputs, used, missing, renormalized: missing.length > 0 && used.length > 0, weights };
}
