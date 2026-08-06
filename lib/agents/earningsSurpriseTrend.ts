import { prisma } from "@/lib/prisma";
import type { EarningsFetchState, EarningsHistory } from "@/lib/generated/prisma";

/**
 * Converts cached EarningsHistory rows (see earningsHistory.ts) into a 0-100
 * "earnings surprise trend" score per symbol — the factor in the target
 * composite (35% momentum/trend + 30% earnings surprise trend + 25% sector
 * leadership + 10% sentiment/news). Replaces the prior "earnings
 * acceleration" factor (forward analyst estimate revisions, sourced from
 * Alpha Vantage's EARNINGS_ESTIMATES endpoint), which live testing on
 * 2026-08-06 confirmed has near-zero real coverage for this app's candidate
 * universe. This factor instead measures trailing surprise momentum
 * (PEAD-style: post-earnings-announcement drift tends to continue in the
 * direction of a standardized surprise), sourced from the EARNINGS endpoint,
 * which has full coverage. Wired into candidateScanner.ts's composite via
 * EARNINGS_SURPRISE_TREND_WEIGHT; sentiment/news is still the only
 * unimplemented factor, so the three implemented factors there are
 * renormalized to fill 100%.
 *
 * Standardized Unexpected Earnings (SUE): a company's raw EPS surprise
 * (reported - estimated) divided by the standard deviation of its own
 * trailing 8 quarters of surprises — this standardizes for how volatile a
 * given company's surprises normally are, so a $0.10 surprise means
 * something very different for a steady utility than for a volatile
 * semiconductor name. Requires 8 quarters of reported history to compute a
 * stable denominator; symbols with less history fall back to a simpler raw
 * surprise percentage (see scoreFromHistory below).
 */

/** Minimum quarters of reported (non-null reportedEPS/estimatedEPS) history required to compute a full SUE score. Below this, the trailing-8-quarter standard deviation isn't a reliable denominator. */
const MIN_QUARTERS_FOR_SUE = 8;

/** The trailing window used to compute the SUE denominator (standard deviation of past surprises) — same as MIN_QUARTERS_FOR_SUE, kept as a separate name since they answer different questions (the requirement vs. the window size). */
const SUE_TRAILING_WINDOW = 8;

/** Recency weights for the last 4 quarters' SUE, most recent first: SUE(most recent) gets the most weight, SUE(q-3) the least. Sums to 1.0. */
const RECENCY_WEIGHTS = [0.4, 0.3, 0.2, 0.1];

const WEIGHTED_SUE_WEIGHT = 0.7;
const TREND_WEIGHT = 0.3;

/**
 * Clamp ceiling for the combined raw score (0.7×weighted SUE + 0.3×trend)
 * before rescaling to 0-100. A magnitude of 3 — i.e. a surprise three
 * standard deviations from a company's own trailing-8-quarter surprise
 * history — is already an extreme, rare result under the standard 3-sigma
 * convention, so this is wide enough that ordinary quarter-to-quarter
 * variation still differentiates instead of collapsing to the same score.
 * Matches the fixed-clamp-and-rescale pattern used by every other sub-score
 * in this composite (momentumTo100, epsTrendToScore, etc.) rather than a
 * cross-symbol (min-max/z-score/percentile) normalization — there's no
 * precedent for cross-symbol normalization anywhere else in this composite,
 * so this factor doesn't introduce one either. See candidateScanner.ts.
 */
const RAW_SCORE_CEILING = 3;

/** Below this absolute estimated EPS, a raw surprise-percentage denominator is too close to zero for a stable ratio — same guard/threshold the prior earnings-acceleration factor used for its EPS-trend leg. */
const FALLBACK_MIN_BASE = 0.05;

/**
 * Clamp ceiling for the low-confidence raw-surprise-percentage fallback
 * (< 8 quarters of history). Wider than the old EPS-trend factor's 0.2
 * ceiling because this compares an actual reported result to a single
 * estimate rather than estimate-to-estimate drift, so it swings more.
 */
const FALLBACK_SURPRISE_CEILING = 0.5;

function rawScoreToScore(raw: number): number {
  const clamped = Math.max(-RAW_SCORE_CEILING, Math.min(RAW_SCORE_CEILING, raw));
  return Math.round(((clamped + RAW_SCORE_CEILING) / (2 * RAW_SCORE_CEILING)) * 100);
}

function fallbackSurprisePctToScore(pct: number): number {
  const clamped = Math.max(-FALLBACK_SURPRISE_CEILING, Math.min(FALLBACK_SURPRISE_CEILING, pct));
  return Math.round(((clamped + FALLBACK_SURPRISE_CEILING) / (2 * FALLBACK_SURPRISE_CEILING)) * 100);
}

/** Sample standard deviation (n-1 denominator) of a fixed 8-quarter surprise window. */
function sampleStdDev(values: number[]): number {
  const n = values.length;
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}

export type EarningsSurpriseTrendCoverage =
  | "sue"
  | "raw_surprise_fallback"
  | "insufficient_data"
  | "no_coverage"
  | "not_yet_fetched";

export interface EarningsSurpriseTrendScore {
  symbol: string;
  /** 0-100; 50 is neutral, used both for a genuinely flat signal and for insufficient-data fallback (see coverage/lowConfidence). */
  score: number;
  coverage: EarningsSurpriseTrendCoverage;
  /** True for anything other than a full 8-quarter SUE calculation — the fallback path, missing/degenerate history, or never fetched. */
  lowConfidence: boolean;
  /** Recency-weighted SUE across the last 4 quarters. Null unless coverage is "sue". */
  weightedSue: number | null;
  /** SUE(most recent) - SUE(q-1). Null unless coverage is "sue". */
  trend: number | null;
  /** 0.7×weightedSue + 0.3×trend, before clamping/rescaling to 0-100. Null unless coverage is "sue". */
  rawScore: number | null;
  /** Raw (reportedEPS - estimatedEPS) / |estimatedEPS| for the most recent quarter. Only set when coverage is "raw_surprise_fallback". */
  mostRecentSurprisePct: number | null;
  /** How many quarters of valid (reported) history were available. */
  quartersUsed: number;
  lastFetchedAt: Date | null;
  rationale: string;
}

function buildRationale(s: Omit<EarningsSurpriseTrendScore, "rationale">): string {
  switch (s.coverage) {
    case "not_yet_fetched":
      return "No earnings history fetched yet for this symbol — scored neutral pending the next refresh.";
    case "no_coverage":
      return "Alpha Vantage has no reported earnings history for this symbol — scored neutral.";
    case "insufficient_data":
      return "No usable reported-vs-estimated EPS data available yet — scored neutral.";
    case "raw_surprise_fallback":
      return `Score ${s.score}/100 (low confidence — only ${s.quartersUsed}/${MIN_QUARTERS_FOR_SUE} quarters of reported history) — most recent surprise ${s.mostRecentSurprisePct! >= 0 ? "+" : ""}${(s.mostRecentSurprisePct! * 100).toFixed(1)}% vs. estimate.`;
    case "sue":
      return `Score ${s.score}/100 — recency-weighted SUE ${s.weightedSue!.toFixed(2)}, trend ${s.trend! >= 0 ? "+" : ""}${s.trend!.toFixed(2)} vs. prior quarter.`;
  }
}

function neutralResult(
  symbol: string,
  coverage: Exclude<EarningsSurpriseTrendCoverage, "sue" | "raw_surprise_fallback">,
  lastFetchedAt: Date | null,
  quartersUsed = 0,
): EarningsSurpriseTrendScore {
  const base: Omit<EarningsSurpriseTrendScore, "rationale"> = {
    symbol,
    score: 50,
    coverage,
    lowConfidence: true,
    weightedSue: null,
    trend: null,
    rawScore: null,
    mostRecentSurprisePct: null,
    quartersUsed,
    lastFetchedAt,
  };
  return { ...base, rationale: buildRationale(base) };
}

/** A quarter with both reportedEPS and estimatedEPS present — the shape the SUE/fallback math needs. Quarters with a null reportedEPS (unreported yet — a normal Alpha Vantage backfill lag, confirmed via live testing 2026-08-06) are excluded before this. */
interface ValidQuarter {
  fiscalDateEnding: Date;
  reportedEPS: number;
  estimatedEPS: number;
}

function fallbackResult(symbol: string, validQuarters: ValidQuarter[], lastFetchedAt: Date | null): EarningsSurpriseTrendScore {
  const mostRecent = validQuarters[0];
  if (Math.abs(mostRecent.estimatedEPS) < FALLBACK_MIN_BASE) {
    return neutralResult(symbol, "insufficient_data", lastFetchedAt, validQuarters.length);
  }

  const pct = (mostRecent.reportedEPS - mostRecent.estimatedEPS) / Math.abs(mostRecent.estimatedEPS);
  const score = fallbackSurprisePctToScore(pct);

  const base: Omit<EarningsSurpriseTrendScore, "rationale"> = {
    symbol,
    score,
    coverage: "raw_surprise_fallback",
    lowConfidence: true,
    weightedSue: null,
    trend: null,
    rawScore: null,
    mostRecentSurprisePct: pct,
    quartersUsed: validQuarters.length,
    lastFetchedAt,
  };
  return { ...base, rationale: buildRationale(base) };
}

function scoreFromHistory(
  symbol: string,
  state: EarningsFetchState | null,
  historyRows: EarningsHistory[],
): EarningsSurpriseTrendScore {
  if (!state || state.lastFetchedAt == null) {
    return neutralResult(symbol, "not_yet_fetched", null);
  }
  if (!state.hasHistory) {
    return neutralResult(symbol, "no_coverage", state.lastFetchedAt);
  }

  const validQuarters: ValidQuarter[] = historyRows
    .filter((r): r is EarningsHistory & { reportedEPS: number; estimatedEPS: number } => r.reportedEPS != null && r.estimatedEPS != null)
    .map((r) => ({ fiscalDateEnding: r.fiscalDateEnding, reportedEPS: r.reportedEPS, estimatedEPS: r.estimatedEPS }))
    .sort((a, b) => b.fiscalDateEnding.getTime() - a.fiscalDateEnding.getTime());

  if (validQuarters.length === 0) {
    return neutralResult(symbol, "insufficient_data", state.lastFetchedAt);
  }

  if (validQuarters.length < MIN_QUARTERS_FOR_SUE) {
    return fallbackResult(symbol, validQuarters, state.lastFetchedAt);
  }

  const window8 = validQuarters.slice(0, SUE_TRAILING_WINDOW);
  const surprises8 = window8.map((q) => q.reportedEPS - q.estimatedEPS);
  const stdDev = sampleStdDev(surprises8);

  // Degenerate zero-variance history (every trailing surprise identical) —
  // can't standardize against a zero denominator. Extremely rare in
  // practice; treat like the low-history fallback rather than dividing by
  // zero or silently scoring neutral.
  if (!(stdDev > 0)) {
    return fallbackResult(symbol, validQuarters, state.lastFetchedAt);
  }

  // sue[0] = most recent quarter's SUE ... sue[3] = q-3's SUE.
  const sue = surprises8.slice(0, 4).map((s) => s / stdDev);
  const weightedSue = RECENCY_WEIGHTS.reduce((sum, w, i) => sum + w * sue[i], 0);
  const trend = sue[0] - sue[1];
  const rawScore = WEIGHTED_SUE_WEIGHT * weightedSue + TREND_WEIGHT * trend;
  const score = rawScoreToScore(rawScore);

  const base: Omit<EarningsSurpriseTrendScore, "rationale"> = {
    symbol,
    score,
    coverage: "sue",
    lowConfidence: false,
    weightedSue,
    trend,
    rawScore,
    mostRecentSurprisePct: null,
    quartersUsed: window8.length,
    lastFetchedAt: state.lastFetchedAt,
  };
  return { ...base, rationale: buildRationale(base) };
}

/**
 * Batched lookup + scoring for a list of candidate symbols — two queries
 * regardless of universe size (fetch state + history rows), rather than a
 * per-symbol round trip, matching the Promise.all-upfront pattern
 * candidateScanner.ts already uses elsewhere. Symbols with no fetch-state row
 * at all (never reached by the cron yet) fall back to coverage
 * "not_yet_fetched" rather than being absent from the returned map.
 */
export async function getEarningsSurpriseTrendScores(symbols: string[]): Promise<Map<string, EarningsSurpriseTrendScore>> {
  const [states, historyRows] = await Promise.all([
    prisma.earningsFetchState.findMany({ where: { symbol: { in: symbols } } }),
    prisma.earningsHistory.findMany({ where: { symbol: { in: symbols } } }),
  ]);

  const stateBySymbol = new Map(states.map((s) => [s.symbol, s]));
  const historyBySymbol = new Map<string, EarningsHistory[]>();
  for (const row of historyRows) {
    const list = historyBySymbol.get(row.symbol);
    if (list) list.push(row);
    else historyBySymbol.set(row.symbol, [row]);
  }

  const result = new Map<string, EarningsSurpriseTrendScore>();
  for (const symbol of symbols) {
    result.set(symbol, scoreFromHistory(symbol, stateBySymbol.get(symbol) ?? null, historyBySymbol.get(symbol) ?? []));
  }
  return result;
}
