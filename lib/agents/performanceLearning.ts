/**
 * Performance Learning — Phase 3
 *
 * Translates recent closed-trade data into actionable learning signals that
 * agent prioritization can consume. Each role's learning domain is modelled:
 * - Risk Manager: protection failures, deep losses
 * - Portfolio Manager: long/short imbalance
 * - Performance Agent: win-rate patterns, setup classes
 * - Engineering Manager: which improvements to prioritize
 */

import { redis } from "@/lib/redis";
import { getTtlSeconds, setWithTtl } from "@/lib/redis/ttl";
import { readTrades } from "@/lib/tradesStore";
import { extractClosedTrades } from "@/lib/performance/tradeStats";
import { nowIso } from "@/lib/agents/time";
import { AGENT_PERF_LEARNING_KEY } from "@/lib/agents/keys";
import type { LossPattern, PerformanceLearningSignals } from "@/lib/agents/types";

const STORE_TTL = getTtlSeconds("TELEMETRY_DAYS");
const DEEP_LOSS_R_THRESHOLD = -1.5; // trades below this R qualify as "deep losses"
const ANALYSIS_DAYS = 30;

function ageFilter(ts: string | undefined, days: number): boolean {
  if (!ts) return true;
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return true;
  const ms = Date.now() - d.getTime();
  return ms <= days * 24 * 60 * 60 * 1000;
}

function safeRate(num: number, denom: number): number {
  if (denom === 0) return 0;
  return Math.round((num / denom) * 1000) / 1000;
}

function safeAvg(sum: number, count: number): number {
  if (count === 0) return 0;
  return Math.round((sum / count) * 1000) / 1000;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function computePerformanceLearning(): Promise<PerformanceLearningSignals> {
  const now = nowIso();
  const all = await readTrades().catch(() => []);
  const closed = extractClosedTrades(Array.isArray(all) ? all : []).filter((t) =>
    ageFilter(t.closedAt || t.updatedAt || t.createdAt, ANALYSIS_DAYS),
  );

  const total = closed.length;
  let wins = 0;
  let pnlSum = 0;
  let rSum = 0;
  let longWins = 0;
  let longCount = 0;
  let shortWins = 0;
  let shortCount = 0;
  let deepLossCount = 0;

  for (const t of closed) {
    const pnl = t.realizedPnL ?? 0;
    const r = t.realizedR ?? 0;
    pnlSum += pnl;
    rSum += r;
    if (pnl > 0) wins += 1;
    if (r <= DEEP_LOSS_R_THRESHOLD) deepLossCount += 1;

    const side = String(t.side ?? "").toUpperCase();
    if (side === "BUY" || side === "LONG") {
      longCount += 1;
      if (pnl > 0) longWins += 1;
    } else if (side === "SELL" || side === "SHORT") {
      shortCount += 1;
      if (pnl > 0) shortWins += 1;
    }
  }

  const winRate = safeRate(wins, total);
  const avgR = safeAvg(rSum, total);
  const longWinRate = safeRate(longWins, longCount);
  const shortWinRate = safeRate(shortWins, shortCount);
  const deepLossRate = safeRate(deepLossCount, total);

  // ─── Pattern mining ────────────────────────────────────────────────────────

  // Group losing trades by time bucket
  const lossByBucket: Record<string, { count: number; rSum: number }> = {};
  const winByBucket: Record<string, { count: number; rSum: number }> = {};
  const lossByTier: Record<string, { count: number; rSum: number }> = {};
  const winByTier: Record<string, { count: number; rSum: number }> = {};

  for (const t of closed) {
    const pnl = t.realizedPnL ?? 0;
    const r = t.realizedR ?? 0;
    const tier = t.tier ?? "REJECT";

    // Time-of-day bucket from closedAt
    const ts = t.closedAt ?? t.updatedAt ?? t.createdAt;
    let timeBucket = "unknown";
    if (ts) {
      const h = new Date(ts).getUTCHours(); // approximate (no ET conversion for simplicity)
      if (h >= 9 && h < 10) timeBucket = "open";
      else if (h >= 10 && h < 12) timeBucket = "mid_morning";
      else if (h >= 12 && h < 15) timeBucket = "afternoon";
      else if (h >= 15 && h < 17) timeBucket = "power_hour";
      else timeBucket = "other";
    }

    if (pnl < 0) {
      lossByBucket[timeBucket] = lossByBucket[timeBucket] ?? { count: 0, rSum: 0 };
      lossByBucket[timeBucket].count += 1;
      lossByBucket[timeBucket].rSum += r;

      lossByTier[tier] = lossByTier[tier] ?? { count: 0, rSum: 0 };
      lossByTier[tier].count += 1;
      lossByTier[tier].rSum += r;
    } else if (pnl > 0) {
      winByBucket[timeBucket] = winByBucket[timeBucket] ?? { count: 0, rSum: 0 };
      winByBucket[timeBucket].count += 1;
      winByBucket[timeBucket].rSum += r;

      winByTier[tier] = winByTier[tier] ?? { count: 0, rSum: 0 };
      winByTier[tier].count += 1;
      winByTier[tier].rSum += r;
    }
  }

  const losingPatterns: LossPattern[] = Object.entries(lossByBucket)
    .filter(([, v]) => v.count >= 2)
    .sort((a, b) => a[1].rSum - b[1].rSum)
    .slice(0, 4)
    .map(([bucket, v]) => ({
      timeOfDay: bucket,
      avgR: safeAvg(v.rSum, v.count),
      count: v.count,
      description: `${v.count} losses in ${bucket} window (avg R ${safeAvg(v.rSum, v.count).toFixed(2)})`,
    }));

  // Also include tier-based loss patterns
  for (const [tier, v] of Object.entries(lossByTier)) {
    if (v.count >= 2) {
      losingPatterns.push({
        tier,
        avgR: safeAvg(v.rSum, v.count),
        count: v.count,
        description: `${v.count} losses in tier ${tier} (avg R ${safeAvg(v.rSum, v.count).toFixed(2)})`,
      });
    }
  }

  const winningPatterns: LossPattern[] = Object.entries(winByBucket)
    .filter(([, v]) => v.count >= 2)
    .sort((a, b) => b[1].rSum - a[1].rSum)
    .slice(0, 4)
    .map(([bucket, v]) => ({
      timeOfDay: bucket,
      avgR: safeAvg(v.rSum, v.count),
      count: v.count,
      description: `${v.count} wins in ${bucket} window (avg R ${safeAvg(v.rSum, v.count).toFixed(2)})`,
    }));

  // ─── Long/Short imbalance ──────────────────────────────────────────────────
  let imbalance = "balanced";
  if (longCount > 0 && shortCount === 0) {
    imbalance = "long_only — no short trades in period";
  } else if (shortCount > 0 && longCount === 0) {
    imbalance = "short_only — no long trades in period";
  } else if (longWinRate > 0 && shortWinRate < longWinRate - 0.15) {
    imbalance = `short_underperforming — long ${(longWinRate * 100).toFixed(0)}% vs short ${(shortWinRate * 100).toFixed(0)}% win rate`;
  } else if (shortWinRate > 0 && longWinRate < shortWinRate - 0.15) {
    imbalance = `long_underperforming — short ${(shortWinRate * 100).toFixed(0)}% vs long ${(longWinRate * 100).toFixed(0)}% win rate`;
  }

  // ─── Weak setup classes ────────────────────────────────────────────────────
  const weakSetupClasses: string[] = [];
  for (const [tier, v] of Object.entries(lossByTier)) {
    const totalInTier = (lossByTier[tier]?.count ?? 0) + (winByTier[tier]?.count ?? 0);
    if (totalInTier >= 3 && v.count / totalInTier > 0.6) {
      weakSetupClasses.push(`tier_${tier}_high_loss_rate`);
    }
  }
  if (shortCount >= 3 && shortWinRate < 0.35) weakSetupClasses.push("short_side_low_win_rate");
  if (deepLossRate > 0.15) weakSetupClasses.push("deep_loss_frequency_elevated");

  // ─── Recommended corrections ───────────────────────────────────────────────
  const corrections: string[] = [];
  if (deepLossRate > 0.15) {
    corrections.push("Tighten stop management — deep loss rate exceeds 15%");
  }
  if (shortWinRate < 0.35 && shortCount >= 3) {
    corrections.push("Review short-side qualification criteria — win rate below 35%");
  }
  if (winRate < 0.4 && total >= 10) {
    corrections.push("Raise minimum score threshold — overall win rate below 40%");
  }
  if (avgR < -0.2 && total >= 5) {
    corrections.push("Improve exit strategy — negative average R across trades");
  }
  const worstBucket = losingPatterns[0];
  if (worstBucket?.timeOfDay && worstBucket.count >= 3) {
    corrections.push(`Consider reducing exposure during ${worstBucket.timeOfDay} session`);
  }

  // ─── Growth opportunities ──────────────────────────────────────────────────
  const growth: string[] = [];
  const bestBucket = winningPatterns[0];
  if (bestBucket?.timeOfDay && bestBucket.count >= 3) {
    growth.push(`Lean into ${bestBucket.timeOfDay} window — best win rate concentration`);
  }
  if (shortCount < 3 && total >= 10) {
    growth.push("Expand short-side capability — under-represented in recent trades");
  }
  if (winRate > 0.55 && total >= 10) {
    growth.push("Consider modest size increase on best setups — win rate is solid");
  }
  for (const [tier, v] of Object.entries(winByTier)) {
    const totalInTier = (lossByTier[tier]?.count ?? 0) + v.count;
    if (totalInTier >= 3 && v.count / totalInTier > 0.65) {
      growth.push(`Tier ${tier} producing well — focus on qualification quality here`);
    }
  }

  const signals: PerformanceLearningSignals = {
    computedAt: now,
    tradePeriodDays: ANALYSIS_DAYS,
    totalTrades: total,
    winRate,
    avgR,
    longWinRate,
    shortWinRate,
    deepLossCount,
    deepLossRate,
    losingPatterns: losingPatterns.slice(0, 6),
    winningPatterns: winningPatterns.slice(0, 4),
    longVsShortImbalance: imbalance,
    weakSetupClasses,
    recommendedCorrections: corrections,
    growthOpportunities: growth,
  };

  // Persist so it can be served from the API
  if (redis) {
    try {
      await setWithTtl(redis, AGENT_PERF_LEARNING_KEY, JSON.stringify(signals), STORE_TTL);
    } catch {
      // non-fatal
    }
  }

  return signals;
}

export async function readPerformanceLearning(): Promise<PerformanceLearningSignals | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get<string>(AGENT_PERF_LEARNING_KEY);
    if (!raw) return null;
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === "object" && "computedAt" in parsed) {
      return parsed as PerformanceLearningSignals;
    }
    return null;
  } catch {
    return null;
  }
}
