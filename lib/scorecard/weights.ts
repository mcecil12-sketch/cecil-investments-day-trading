import type { ScorecardWeights } from "./types";

// Return on Capital is weighted at 50% per requirement.
export const SCORECARD_WEIGHTS: ScorecardWeights = {
  returnOnCapital: 0.50,
  winRate: 0.20,
  avgR: 0.20,
  discipline: 0.10,
};

export function validateWeights(w: ScorecardWeights) {
  const sum =
    w.returnOnCapital + w.winRate + w.avgR + w.discipline;
  const rounded = Math.round(sum * 1000) / 1000;
  if (rounded !== 1) {
    throw new Error(`Scorecard weights must sum to 1.0; got ${sum}`);
  }
  for (const [k, v] of Object.entries(w)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new Error(`Invalid weight ${k}=${v}`);
    }
  }
  return true;
}

