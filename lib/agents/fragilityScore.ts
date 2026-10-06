import type { PricePoint } from "@/lib/agents/marketData";

/**
 * Logging-only "fragility" signals for the candidate scans — pure functions
 * over price history the scans have already fetched, no I/O. NOT part of the
 * composite score, ranking, or banding (see the dated note in
 * scoringShared.ts); logged on every CandidateRecommendationLog row so the
 * Performance Analyst can test whether they predict underperformance.
 */

/** Oct 6 2026, set from STX postmortem, hypothesis only, validate before use. */
export const FRAGILITY_EXTENSION_THRESHOLD = 0.25;
/** Oct 6 2026, set from STX postmortem, hypothesis only, validate before use. */
export const FRAGILITY_VOL_THRESHOLD = 0.6;

const SMA_WINDOW = 200;
const VOL_WINDOW = 60;
const TRADING_DAYS_PER_YEAR = 252;
const BETA_WINDOW = 252;

export interface FragilityMetrics {
  extensionVs200d: number | null;
  vol60d: number | null;
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

/** True if extension >= FRAGILITY_EXTENSION_THRESHOLD OR vol >= FRAGILITY_VOL_THRESHOLD. Null only when neither metric is available. */
export function fragilityFlag(extension: number | null, vol: number | null): boolean | null {
  if (extension == null && vol == null) return null;
  return (
    (extension != null && extension >= FRAGILITY_EXTENSION_THRESHOLD) ||
    (vol != null && vol >= FRAGILITY_VOL_THRESHOLD)
  );
}

/** Never throws — any failure yields all-null metrics so a scan can't fail because of this logging-only factor. */
export function computeFragility(points: PricePoint[]): FragilityMetrics {
  try {
    const extension = extensionVs200d(points);
    const vol = vol60d(points);
    const flag = fragilityFlag(extension, vol);
    return { extensionVs200d: extension, vol60d: vol, fragilityFlag: flag };
  } catch {
    return { extensionVs200d: null, vol60d: null, fragilityFlag: null };
  }
}
