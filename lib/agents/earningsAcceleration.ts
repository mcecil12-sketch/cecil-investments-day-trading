import { prisma } from "@/lib/prisma";
import type { EarningsEstimateSnapshot } from "@/lib/generated/prisma";

/**
 * Converts cached EarningsEstimateSnapshot rows (see earningsEstimates.ts)
 * into a 0-100 "earnings acceleration" score per symbol — the factor in the
 * target composite (35% momentum/trend + 30% earnings acceleration + 25%
 * sector leadership + 10% sentiment/news). Wired into candidateScanner.ts's
 * composite via EARNINGS_ACCELERATION_WEIGHT; sentiment/news is still the
 * only unimplemented factor, so the three implemented factors there are
 * renormalized to fill 100%.
 */

/** Below this absolute EPS estimate, a percent-change denominator is too close to zero to be a stable signal (common for recently-unprofitable or barely-profitable companies) — treated as unavailable rather than producing a wild swing. */
const EPS_TREND_MIN_BASE = 0.05;

/** EPS estimate revisions of this magnitude over a quarter are already extreme — much smaller than the return ranges used elsewhere (e.g. momentumTo100's price-based scale), since analyst estimates move far less than prices. */
const EPS_TREND_CEILING = 0.2;

const EPS_TREND_WEIGHT = 0.6;
const REVISION_BREADTH_WEIGHT = 0.4;
const REVISION_30D_WEIGHT = 0.7;
const REVISION_7D_WEIGHT = 0.3;

/**
 * Fractional change in the current-quarter EPS estimate over the trailing
 * quarter (current vs. 90-days-ago). Null when either side is missing or the
 * 90-days-ago estimate is too close to zero for a stable ratio — distinct
 * from an actual 0% change, which is a real, informative value.
 */
function computeEpsTrendPct(current: number | null, ninetyDaysAgo: number | null): number | null {
  if (current == null || ninetyDaysAgo == null) return null;
  if (Math.abs(ninetyDaysAgo) < EPS_TREND_MIN_BASE) return null;
  return (current - ninetyDaysAgo) / Math.abs(ninetyDaysAgo);
}

function epsTrendToScore(pct: number | null): number | null {
  if (pct == null) return null;
  const clamped = Math.max(-EPS_TREND_CEILING, Math.min(EPS_TREND_CEILING, pct));
  return ((clamped + EPS_TREND_CEILING) / (2 * EPS_TREND_CEILING)) * 100;
}

/**
 * Net revision breadth: (up - down) / (up + down), -1..1. Null only when a
 * count is actually missing (Alpha Vantage didn't report it) — up=0/down=0
 * (analysts reported, none revised either way this window) is a real,
 * informative 0, not a missing value, matching the same null-vs-zero
 * distinction the schema itself preserves.
 */
function netRevisionBreadth(up: number | null, down: number | null): number | null {
  if (up == null || down == null) return null;
  const total = up + down;
  if (total === 0) return 0;
  return (up - down) / total;
}

function breadthToScore(breadth: number | null): number | null {
  if (breadth == null) return null;
  const clamped = Math.max(-1, Math.min(1, breadth));
  return ((clamped + 1) / 2) * 100;
}

/** Blends the 30-day and 7-day revision-breadth scores (30d weighted more — more analysts, more stable signal; 7d adds a shorter-term confirmation), redistributing fully to whichever leg is available when the other is null. */
function blendRevisionScore(breadth30: number | null, breadth7: number | null): number | null {
  const score30 = breadthToScore(breadth30);
  const score7 = breadthToScore(breadth7);
  if (score30 == null && score7 == null) return null;
  if (score30 == null) return score7;
  if (score7 == null) return score30;
  return score30 * REVISION_30D_WEIGHT + score7 * REVISION_7D_WEIGHT;
}

/** Combines the EPS-trend and revision-breadth legs (60/40), redistributing fully to whichever leg is available when the other is null, and falling back to neutral (50) only when both are unavailable. */
function combineEarningsLegs(epsTrendScore: number | null, revisionScore: number | null): number {
  if (epsTrendScore == null && revisionScore == null) return 50;
  if (epsTrendScore == null) return revisionScore as number;
  if (revisionScore == null) return epsTrendScore;
  return epsTrendScore * EPS_TREND_WEIGHT + revisionScore * REVISION_BREADTH_WEIGHT;
}

export type EarningsAccelerationCoverage = "covered" | "no_coverage" | "not_yet_fetched";

export interface EarningsAccelerationScore {
  symbol: string;
  /** 0-100; 50 is neutral, used both for a genuinely flat signal and for insufficient-data fallback (see coverage). */
  score: number;
  coverage: EarningsAccelerationCoverage;
  epsTrendPct: number | null;
  netRevisionBreadth30d: number | null;
  netRevisionBreadth7d: number | null;
  lastFetchedAt: Date | null;
  rationale: string;
}

function buildRationale(score: EarningsAccelerationScore): string {
  if (score.coverage === "not_yet_fetched") {
    return "No earnings-estimate data fetched yet for this symbol — scored neutral pending the weekly refresh.";
  }
  if (score.coverage === "no_coverage") {
    return "Alpha Vantage has no usable current-quarter estimate data for this symbol — scored neutral.";
  }
  const parts: string[] = [];
  parts.push(
    score.epsTrendPct == null
      ? "current-quarter EPS estimate trend unavailable"
      : `current-quarter EPS estimate ${score.epsTrendPct >= 0 ? "up" : "down"} ${Math.abs(score.epsTrendPct * 100).toFixed(1)}% vs. 90 days ago`,
  );
  parts.push(
    score.netRevisionBreadth30d == null
      ? "30-day revision breadth unavailable"
      : `30-day revision breadth ${score.netRevisionBreadth30d >= 0 ? "+" : ""}${(score.netRevisionBreadth30d * 100).toFixed(0)}%`,
  );
  return `Score ${score.score}/100 — ${parts.join(", ")}.`;
}

function scoreFromSnapshot(symbol: string, row: EarningsEstimateSnapshot | null): EarningsAccelerationScore {
  if (!row || row.lastFetchedAt == null) {
    const base: EarningsAccelerationScore = {
      symbol,
      score: 50,
      coverage: "not_yet_fetched",
      epsTrendPct: null,
      netRevisionBreadth30d: null,
      netRevisionBreadth7d: null,
      lastFetchedAt: null,
      rationale: "",
    };
    return { ...base, rationale: buildRationale(base) };
  }

  if (!row.hasEstimates) {
    const base: EarningsAccelerationScore = {
      symbol,
      score: 50,
      coverage: "no_coverage",
      epsTrendPct: null,
      netRevisionBreadth30d: null,
      netRevisionBreadth7d: null,
      lastFetchedAt: row.lastFetchedAt,
      rationale: "",
    };
    return { ...base, rationale: buildRationale(base) };
  }

  const epsTrendPct = computeEpsTrendPct(row.epsEstimateAverageCurrent, row.epsEstimateAverage90DaysAgo);
  const netRevisionBreadth30d = netRevisionBreadth(row.revisionUpTrailing30Days, row.revisionDownTrailing30Days);
  const netRevisionBreadth7d = netRevisionBreadth(row.revisionUpTrailing7Days, row.revisionDownTrailing7Days);

  const epsTrendScore = epsTrendToScore(epsTrendPct);
  const revisionScore = blendRevisionScore(netRevisionBreadth30d, netRevisionBreadth7d);
  const score = Math.max(0, Math.min(100, Math.round(combineEarningsLegs(epsTrendScore, revisionScore))));

  const base: EarningsAccelerationScore = {
    symbol,
    score,
    coverage: "covered",
    epsTrendPct,
    netRevisionBreadth30d,
    netRevisionBreadth7d,
    lastFetchedAt: row.lastFetchedAt,
    rationale: "",
  };
  return { ...base, rationale: buildRationale(base) };
}

/**
 * Batched lookup + scoring for a list of candidate symbols — one query
 * regardless of universe size, rather than a per-symbol round trip (matches
 * the Promise.all-upfront pattern candidateScanner.ts already uses for
 * holdings/dynamic universe). Symbols with no cached row at all (never
 * reached by the weekly cron yet) fall back to coverage "not_yet_fetched"
 * rather than being absent from the returned map.
 */
export async function getEarningsAccelerationScores(symbols: string[]): Promise<Map<string, EarningsAccelerationScore>> {
  const rows = await prisma.earningsEstimateSnapshot.findMany({ where: { symbol: { in: symbols } } });
  const rowBySymbol = new Map(rows.map((row) => [row.symbol, row]));

  const result = new Map<string, EarningsAccelerationScore>();
  for (const symbol of symbols) {
    result.set(symbol, scoreFromSnapshot(symbol, rowBySymbol.get(symbol) ?? null));
  }
  return result;
}
