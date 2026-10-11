import type { PricePoint } from "@/lib/agents/marketData";

/**
 * Logging-only "fragility" signals for the candidate scans — pure functions
 * over price history the scans have already fetched, no I/O. NOT part of the
 * composite score, ranking, or banding (see the dated note in
 * scoringShared.ts); logged on every CandidateRecommendationLog row so the
 * Performance Analyst can test whether they predict underperformance.
 */

/**
 * SUPERSEDED (Oct 11 2026). Oct 6 2026, set from STX postmortem, hypothesis
 * only, validate before use: extension >= 0.25 OR vol >= 0.60.
 * Oct 11 2026: absolute thresholds flagged 60% of candidates, no discriminating
 * power; redefined as relative before any outcome data existed. The constants
 * and `fragilityFlag()` below are kept only for reference/tests — scans no
 * longer use them; see applyFragilityCohort().
 */
export const FRAGILITY_EXTENSION_THRESHOLD = 0.25;
/** SUPERSEDED Oct 11 2026 — see above. */
export const FRAGILITY_VOL_THRESHOLD = 0.6;

/** Smallest cohort (members with a percentile) for which a "top third" is defined; below it the flag stays null. */
export const MIN_FRAGILITY_COHORT_SIZE = 3;

const SMA_WINDOW = 200;
const VOL_WINDOW = 60;
const TRADING_DAYS_PER_YEAR = 252;
const BETA_WINDOW = 252;

export interface FragilityMetrics {
  extensionVs200d: number | null;
  vol60d: number | null;
  /** Cohort-relative; always null from computeFragility — set by applyFragilityCohort once the scan's ranked cohort is known. */
  fragilityPercentile: number | null;
  fragilityFlag: boolean | null;
}

function sortedAscending(points: PricePoint[]): PricePoint[] {
  return [...points].sort((a, b) => a.date.getTime() - b.date.getTime());
}

function isUsable(close: number): boolean {
  return Number.isFinite(close) && close > 0;
}

/** (lastClose / SMA200) - 1 over the last 200 daily bars. Null with fewer than 200 bars. */
export function extensionVs200d(points: PricePoint[]): number | null {
  if (points.length < SMA_WINDOW) return null;
  const window = sortedAscending(points).slice(-SMA_WINDOW);
  if (!window.every((p) => isUsable(p.close))) return null;
  const sma = window.reduce((sum, p) => sum + p.close, 0) / SMA_WINDOW;
  return window[window.length - 1].close / sma - 1;
}

function logReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) out.push(Math.log(closes[i] / closes[i - 1]));
  return out;
}

function sampleStdev(values: number[]): number {
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Annualized stdev of daily log returns over the last 60 bars. Null with fewer than 60 bars. */
export function vol60d(points: PricePoint[]): number | null {
  if (points.length < VOL_WINDOW) return null;
  const window = sortedAscending(points).slice(-VOL_WINDOW);
  if (!window.every((p) => isUsable(p.close))) return null;
  return sampleStdev(logReturns(window.map((p) => p.close))) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/** Latest close and its UTC trading date from a price series — the price behind the logged market cap. */
export function latestClose(points: PricePoint[]): { lastClose: number | null; priceDate: string | null } {
  let best: PricePoint | null = null;
  for (const p of points) if (Number.isFinite(p.close) && p.close > 0 && (!best || p.date.getTime() > best.date.getTime())) best = p;
  return best ? { lastClose: best.close, priceDate: best.date.toISOString().slice(0, 10) } : { lastClose: null, priceDate: null };
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * ~1y daily beta of a stock vs. an index series, using only dates present in
 * both. Null when fewer than 60 overlapping daily returns or the index has
 * zero variance. Not currently persisted — available for analysis only.
 */
export function betaVsSpx(stock: PricePoint[], spx: PricePoint[]): number | null {
  const spxByDay = new Map(spx.map((p) => [dayKey(p.date), p.close]));
  const aligned = sortedAscending(stock)
    .map((p) => ({ stock: p.close, spx: spxByDay.get(dayKey(p.date)) }))
    .filter((p): p is { stock: number; spx: number } => p.spx != null && isUsable(p.stock) && isUsable(p.spx))
    .slice(-(BETA_WINDOW + 1));
  if (aligned.length < VOL_WINDOW + 1) return null;

  const rs = logReturns(aligned.map((p) => p.stock));
  const rm = logReturns(aligned.map((p) => p.spx));
  const meanS = rs.reduce((s, v) => s + v, 0) / rs.length;
  const meanM = rm.reduce((s, v) => s + v, 0) / rm.length;
  let cov = 0;
  let varM = 0;
  for (let i = 0; i < rs.length; i++) {
    cov += (rs[i] - meanS) * (rm[i] - meanM);
    varM += (rm[i] - meanM) ** 2;
  }
  return varM === 0 ? null : cov / varM;
}

/** SUPERSEDED Oct 11 2026 (absolute thresholds; see top of file). True if extension >= FRAGILITY_EXTENSION_THRESHOLD OR vol >= FRAGILITY_VOL_THRESHOLD. Null only when neither metric is available. */
export function fragilityFlag(extension: number | null, vol: number | null): boolean | null {
  if (extension == null && vol == null) return null;
  return (
    (extension != null && extension >= FRAGILITY_EXTENSION_THRESHOLD) ||
    (vol != null && vol >= FRAGILITY_VOL_THRESHOLD)
  );
}

/** Raw per-symbol metrics only (never throws — any failure yields all-null). The percentile/flag depend on the cohort; see applyFragilityCohort. */
export function computeFragility(points: PricePoint[]): FragilityMetrics {
  try {
    return { extensionVs200d: extensionVs200d(points), vol60d: vol60d(points), fragilityPercentile: null, fragilityFlag: null };
  } catch {
    return { extensionVs200d: null, vol60d: null, fragilityPercentile: null, fragilityFlag: null };
  }
}

/** Mid-rank percentile (0-100) of each value within `values`: (count below + half the count equal, incl. itself) / n. Ties share a rank. */
export function percentileRanks(values: number[]): number[] {
  const n = values.length;
  return values.map((v) => {
    let below = 0;
    let equal = 0;
    for (const w of values) {
      if (w < v) below++;
      else if (w === v) equal++;
    }
    return ((below + 0.5 * equal) / n) * 100;
  });
}

/**
 * Oct 11 2026: absolute thresholds flagged 60% of candidates, no discriminating
 * power; redefined as relative before any outcome data existed.
 *
 * fragilityPercentile = mean of the cohort percentile ranks (0-100) of
 * extensionVs200d and vol60d (over whichever of the two a member has; null if
 * neither). fragilityFlag = the percentile is in the top third of the cohort:
 * at or above the ceil(m/3)-th highest percentile among the m members that
 * have one (ties at the cut are all flagged). Cohorts under
 * MIN_FRAGILITY_COHORT_SIZE leave the flag null. The cohort is the scan's own
 * ranked list (monthly: the 30 ranked candidates; weekly: the top 15).
 * Mutates and returns `cohort`. Logging-only — never touches score or rank.
 */
export function applyFragilityCohort<T extends { extensionVs200d: number | null; vol60d: number | null; fragilityPercentile: number | null; fragilityFlag: boolean | null }>(
  cohort: T[],
): T[] {
  const ext = cohort.filter((c) => c.extensionVs200d != null);
  const vol = cohort.filter((c) => c.vol60d != null);
  const extPct = percentileRanks(ext.map((e) => e.extensionVs200d as number));
  const volPct = percentileRanks(vol.map((e) => e.vol60d as number));
  const extRank = new Map(ext.map((c, i) => [c, extPct[i]]));
  const volRank = new Map(vol.map((c, i) => [c, volPct[i]]));

  for (const c of cohort) {
    const parts = [extRank.get(c), volRank.get(c)].filter((v): v is number => v != null);
    c.fragilityPercentile = parts.length > 0 ? parts.reduce((s, v) => s + v, 0) / parts.length : null;
    c.fragilityFlag = null;
  }
  const withPct = cohort.filter((c) => c.fragilityPercentile != null);
  if (withPct.length >= MIN_FRAGILITY_COHORT_SIZE) {
    const sorted = withPct.map((c) => c.fragilityPercentile as number).sort((a, b) => b - a);
    const cut = sorted[Math.ceil(withPct.length / 3) - 1];
    for (const c of withPct) c.fragilityFlag = (c.fragilityPercentile as number) >= cut;
  }
  return cohort;
}
