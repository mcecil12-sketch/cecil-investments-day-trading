import { NextResponse } from "next/server";
import { readTrades } from "@/lib/tradesStore";
import { extractClosedTrades, buildAnalytics } from "@/lib/performance/tradeStats";
import { readPerformanceLearning } from "@/lib/agents/performanceLearning";
import { readExperiments } from "@/lib/agents/experimentTracker";
import { readProfitEngineStatus } from "@/lib/agents/profitEngine";
import { round, safeDiv } from "@/lib/performance/math";

export const dynamic = "force-dynamic";

function rangeFilter(range: string | null, ts: string | undefined): boolean {
  if (!ts) return true;
  const r = String(range || "30d").toLowerCase();
  if (r === "all") return true;
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return true;
  const now = new Date();
  const ms = now.getTime() - d.getTime();
  const day = 24 * 60 * 60 * 1000;
  if (r === "today") return ms <= day;
  if (r === "week" || r === "7d") return ms <= 7 * day;
  if (r === "30d" || r === "month") return ms <= 30 * day;
  return true;
}

function computeDuration(t: { openedAt?: string; closedAt?: string; executedAt?: string; createdAt?: string }): number | null {
  const openTs = t.openedAt ?? t.executedAt ?? t.createdAt;
  const closeTs = t.closedAt;
  if (!openTs || !closeTs) return null;
  const diff = new Date(closeTs).getTime() - new Date(openTs).getTime();
  return Number.isFinite(diff) && diff >= 0 ? Math.round(diff / 1000 / 60) : null; // minutes
}

function computeMaxDrawdown(trades: { realizedPnL?: number }[]): number {
  let peak = 0;
  let equity = 0;
  let maxDD = 0;
  for (const t of trades) {
    equity += t.realizedPnL ?? 0;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }
  return round(maxDD, 2);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const range = url.searchParams.get("range") || "30d";

  const [all, learning, experiments, engineStatus] = await Promise.all([
    readTrades().catch(() => []),
    readPerformanceLearning().catch(() => null),
    readExperiments().catch(() => null),
    readProfitEngineStatus().catch(() => null),
  ]);

  const closed = extractClosedTrades(Array.isArray(all) ? all : []).filter((t) =>
    rangeFilter(range, t.closedAt ?? t.updatedAt ?? t.createdAt),
  );
  const analytics = buildAnalytics(closed);

  // ── Setup-type performance ─────────────────────────────────────────
  // Group by setupQualityTags[0] or performanceBucket
  const bySetupType: Record<string, { wins: number; losses: number; rSum: number; count: number }> = {};
  for (const t of closed) {
    const setup = t.setupQualityTags?.[0] ?? t.performanceBucket ?? "unknown";
    bySetupType[setup] = bySetupType[setup] ?? { wins: 0, losses: 0, rSum: 0, count: 0 };
    bySetupType[setup].count++;
    bySetupType[setup].rSum += t.realizedR ?? 0;
    if ((t.realizedPnL ?? 0) > 0) bySetupType[setup].wins++;
    if ((t.realizedPnL ?? 0) < 0) bySetupType[setup].losses++;
  }
  const setupTypePerformance = Object.fromEntries(
    Object.entries(bySetupType)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([k, v]) => [
        k,
        {
          trades: v.count,
          wins: v.wins,
          losses: v.losses,
          winRate: round(safeDiv(v.wins, v.count, 0) * 100, 1),
          avgR: round(safeDiv(v.rSum, v.count, 0), 3),
        },
      ]),
  );

  // ── Rejection reasons vs success ──────────────────────────────────
  const rejectionBreakdown: Record<string, number> = {};
  for (const t of closed) {
    for (const tag of t.rejectionTags ?? []) {
      rejectionBreakdown[tag] = (rejectionBreakdown[tag] ?? 0) + 1;
    }
  }

  // ── Trade duration stats ──────────────────────────────────────────
  const durations = closed.map(computeDuration).filter((d): d is number => d !== null);
  const avgDurationMin = durations.length > 0
    ? round(durations.reduce((a, b) => a + b, 0) / durations.length, 1)
    : null;
  const medianDurationMin = durations.length > 0
    ? (() => {
        const sorted = [...durations].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0
          ? round((sorted[mid - 1] + sorted[mid]) / 2, 1)
          : sorted[mid];
      })()
    : null;

  // ── Winners vs losers avgR ────────────────────────────────────────
  const winners = closed.filter((t) => (t.realizedPnL ?? 0) > 0);
  const losers = closed.filter((t) => (t.realizedPnL ?? 0) < 0);
  const avgRWinners = winners.length > 0
    ? round(winners.reduce((s, t) => s + (t.realizedR ?? 0), 0) / winners.length, 3)
    : null;
  const avgRLosers = losers.length > 0
    ? round(losers.reduce((s, t) => s + (t.realizedR ?? 0), 0) / losers.length, 3)
    : null;

  // ── Max drawdown ──────────────────────────────────────────────────
  const maxDrawdown = computeMaxDrawdown(closed);

  // ── Experiment summary ────────────────────────────────────────────
  const recentExperiments = (experiments?.experiments ?? [])
    .slice(-10)
    .reverse()
    .map((e) => ({
      id: e.id,
      optimizationType: e.optimizationType,
      status: e.status,
      deltaWinRate: e.deltaWinRate,
      deltaR: e.deltaR,
      revertRecommended: e.revertRecommended,
      createdAt: e.createdAt,
    }));

  return NextResponse.json({
    ok: true,
    range,
    meta: { closedTrades: closed.length },

    // ── Core performance ──────────────────────────────────────────
    totals: analytics.totals,
    byTier: analytics.byTier,
    byDirection: analytics.byDirection,
    byBucket: analytics.byBucket,

    // ── Extended scorecard ────────────────────────────────────────
    avgRWinners,
    avgRLosers,
    maxDrawdown,
    avgDurationMin,
    medianDurationMin,
    setupTypePerformance,
    rejectionBreakdown,

    // ── Learning signals ──────────────────────────────────────────
    learningSignals: learning
      ? {
          winRate: learning.winRate,
          avgR: learning.avgR,
          weakSetupClasses: learning.weakSetupClasses,
          recommendedCorrections: learning.recommendedCorrections,
          computedAt: learning.computedAt,
        }
      : null,

    // ── Profit engine status ──────────────────────────────────────
    profitEngine: engineStatus
      ? {
          active: engineStatus.engineActive,
          funnelBlocked: engineStatus.funnelBlocked,
          funnelBlockedReason: engineStatus.funnelBlockedReason,
          lastRunAt: engineStatus.lastRunAt,
          lastOptimizationType: engineStatus.lastOptimizationType,
          optimizationImpact: engineStatus.optimizationImpact,
        }
      : null,

    // ── Experiment tracking ────────────────────────────────────────
    experiments: recentExperiments,

    // ── Recommendations ───────────────────────────────────────────
    recommendations: analytics.recommendations,
  });
}
