import { round, safeDiv, num } from "@/lib/performance/math";
import { bucketET, etParts } from "@/lib/performance/time";

export type ClosedTrade = {
  id?: string;
  ticker?: string;
  side?: string;
  status?: string;

  createdAt?: string;
  openedAt?: string;
  closedAt?: string;
  executedAt?: string;
  updatedAt?: string;

  tier?: "A" | "B" | "C" | "REJECT";
  score?: number;
  grade?: string;

  realizedPnL?: number;
  realizedR?: number;

  entryPrice?: number;
  exitPrice?: number;
  stopPrice?: number;
  quantity?: number;

  source?: string;

  // Quality tag fields (v2 performance upgrade)
  performanceBucket?: string;
  setupQualityTags?: string[];
  rejectionTags?: string[];
  trendBucket?: string;
  vwapBucket?: string;
  relVolBucket?: string;
};

function isClosed(t: any) {
  const s = String(t?.status || "").toUpperCase();
  return s === "CLOSED" || s === "DONE" || s === "EXITED";
}

function pickCloseTs(t: any): string | null {
  return (
    (typeof t?.closedAt === "string" && t.closedAt) ||
    (typeof t?.exitAt === "string" && t.exitAt) ||
    (typeof t?.updatedAt === "string" && t.updatedAt) ||
    null
  );
}

function normTier(t: any): "A" | "B" | "C" | "REJECT" {
  const raw = String(t?.tier || t?.ai?.tier || "").toUpperCase();
  if (raw === "A" || raw === "B" || raw === "C" || raw === "REJECT") return raw as any;
  return "REJECT";
}


function inferScore(t: any): number | null {
  const v =
    t?.score ??
    t?.aiScore ??
    t?.signalScore ??
    t?.ai?.score ??
    t?.ai?.aiScore ??
    t?.signal?.score;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function inferTierFromScore(score: number | null): "A" | "B" | "C" | "REJECT" {
  if (score == null) return "REJECT";
  if (score >= 8.5) return "A";
  if (score >= 7.5) return "B";
  if (score >= 6.5) return "C";
  return "REJECT";
}

function inferTier(t: any): "A" | "B" | "C" | "REJECT" {
  const rawTier = String(t?.tier ?? t?.ai?.tier ?? t?.signalTier ?? "").toUpperCase();
  if (rawTier === "A" || rawTier === "B" || rawTier === "C" || rawTier === "REJECT") return rawTier as any;

  const rawGrade = String(t?.grade ?? t?.ai?.grade ?? t?.signalGrade ?? "").toUpperCase();
  if (rawGrade === "A" || rawGrade === "B" || rawGrade === "C") return rawGrade as any;

  return inferTierFromScore(inferScore(t));
}

function inferGrade(t: any): string | undefined {
  const g = t?.grade ?? t?.ai?.grade ?? t?.signalGrade;
  return typeof g === "string" && g ? g : undefined;
}

export function extractClosedTrades(allTrades: any[]): ClosedTrade[] {
  const src = Array.isArray(allTrades) ? allTrades : [];
  return src
    .filter((t) => isClosed(t) && typeof (t as any)?.realizedPnL === "number")
    .map((t) => {
      const closedAt = pickCloseTs(t);
      return {
        id: t?.id,
        ticker: t?.ticker,
        side: t?.side,
        status: t?.status,
        createdAt: t?.createdAt,
        openedAt: t?.openedAt ?? t?.executedAt,
        executedAt: t?.executedAt,
        closedAt: closedAt || undefined,
        updatedAt: t?.updatedAt,
        tier: inferTier(t),
        score: (num(t?.score, null) ?? num((t as any)?.ai?.score, null) ?? undefined),
        grade: (typeof t?.grade === "string" ? t.grade : (typeof (t as any)?.ai?.grade === "string" ? (t as any).ai.grade : undefined)),
        realizedPnL: num(t?.realizedPnL, null) ?? undefined,
        realizedR: num(t?.realizedR, null) ?? undefined,
        entryPrice: num(t?.entryPrice, null) ?? undefined,
        exitPrice: num(t?.exitPrice, null) ?? undefined,
        stopPrice: num(t?.stopPrice, null) ?? undefined,
        quantity: num(t?.quantity ?? t?.qty, null) ?? undefined,
        source: typeof t?.source === "string" ? t.source : undefined,
        // Quality tag fields
        performanceBucket: typeof t?.performanceBucket === "string" ? t.performanceBucket : undefined,
        setupQualityTags: Array.isArray(t?.setupQualityTags) ? t.setupQualityTags : undefined,
        rejectionTags: Array.isArray(t?.rejectionTags) ? t.rejectionTags : undefined,
        trendBucket: typeof t?.trendBucket === "string" ? t.trendBucket : undefined,
        vwapBucket: typeof t?.vwapBucket === "string" ? t.vwapBucket : undefined,
        relVolBucket: typeof t?.relVolBucket === "string" ? t.relVolBucket : undefined,
      };
    });
}

export type AnalyticsTotals = {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  realizedPnL: number;
  avgPnL: number;
  realizedR: number;
  avgR: number;
};

function emptyTotals(): AnalyticsTotals {
  return { trades: 0, wins: 0, losses: 0, winRate: 0, realizedPnL: 0, avgPnL: 0, realizedR: 0, avgR: 0 };
}

function addTrade(tot: AnalyticsTotals, t: ClosedTrade) {
  const pnl = num(t.realizedPnL, 0) ?? 0;
  const r = num(t.realizedR, 0) ?? 0;
  tot.trades += 1;
  tot.realizedPnL = round(tot.realizedPnL + pnl, 2);
  tot.realizedR = round(tot.realizedR + r, 3);
  if (pnl > 0) tot.wins += 1;
  if (pnl < 0) tot.losses += 1;
}

function finalizeTotals(tot: AnalyticsTotals) {
  tot.winRate = round(safeDiv(tot.wins, tot.trades, 0) * 100, 2);
  tot.avgPnL = round(safeDiv(tot.realizedPnL, tot.trades, 0), 2);
  tot.avgR = round(safeDiv(tot.realizedR, tot.trades, 0), 3);
  return tot;
}

export function buildAnalytics(trades: ClosedTrade[]) {
  const totals = emptyTotals();

  const byTier: Record<string, AnalyticsTotals> = {
    A: emptyTotals(),
    B: emptyTotals(),
    C: emptyTotals(),
    REJECT: emptyTotals(),
  };

  const byBucket: Record<string, AnalyticsTotals> = {
    open: emptyTotals(),
    mid: emptyTotals(),
    power: emptyTotals(),
    after: emptyTotals(),
  };

  // Direction breakdown
  const byDirection: Record<string, AnalyticsTotals> = {
    LONG: emptyTotals(),
    SHORT: emptyTotals(),
  };

  // Performance bucket breakdown (flat_trend_long, c_clean_long etc.)
  const byPerformanceBucket: Record<string, AnalyticsTotals> = {};

  for (const t of trades) {
    addTrade(totals, t);
    addTrade(byTier[t.tier || "REJECT"] || byTier.REJECT, t);

    const ts = t.closedAt || t.executedAt || t.openedAt || t.createdAt;
    const { hhmm } = etParts(ts || undefined);
    const b = bucketET(hhmm);
    addTrade(byBucket[b], t);

    // Direction
    const dir = String(t.side || "").toUpperCase();
    if (dir === "LONG" || dir === "SHORT") {
      addTrade(byDirection[dir], t);
    }

    // Performance bucket
    const pb = t.performanceBucket || `${(t.tier || "REJECT").toLowerCase()}_${dir.toLowerCase() || "unknown"}`;
    if (!byPerformanceBucket[pb]) byPerformanceBucket[pb] = emptyTotals();
    addTrade(byPerformanceBucket[pb], t);
  }

  const finalizedByPerformanceBucket = Object.fromEntries(
    Object.entries(byPerformanceBucket).map(([k, v]) => [k, finalizeTotals(v)])
  );

  const recommendations = buildRecommendations({
    byTier: Object.fromEntries(Object.entries(byTier).map(([k, v]) => [k, finalizeTotals(v)])),
    byDirection: Object.fromEntries(Object.entries(byDirection).map(([k, v]) => [k, finalizeTotals(v)])),
    byPerformanceBucket: finalizedByPerformanceBucket,
    minSampleSize: 3,
  });

  return {
    totals: finalizeTotals(totals),
    byTier: Object.fromEntries(Object.entries(byTier).map(([k, v]) => [k, finalizeTotals(v)])),
    byBucket: Object.fromEntries(Object.entries(byBucket).map(([k, v]) => [k, finalizeTotals(v)])),
    byDirection: Object.fromEntries(Object.entries(byDirection).map(([k, v]) => [k, finalizeTotals(v)])),
    byPerformanceBucket: finalizedByPerformanceBucket,
    recommendations,
  };
}

export type PerformanceRecommendation = {
  action: "tighten_c_tier" | "disable_c_tier" | "block_flat_trend_long" | "restrict_shorts" | "no_action";
  reason: string;
  avgR?: number;
  sampleSize?: number;
  urgency: "high" | "medium" | "low";
};

/**
 * Build adaptive restriction recommendations from recent closed trade performance.
 * Returns action hints — does NOT auto-disable anything. Surfaced in /api/performance/analytics.
 */
function buildRecommendations(params: {
  byTier: Record<string, AnalyticsTotals>;
  byDirection: Record<string, AnalyticsTotals>;
  byPerformanceBucket: Record<string, AnalyticsTotals>;
  minSampleSize: number;
}): PerformanceRecommendation[] {
  const { byTier, byDirection, byPerformanceBucket, minSampleSize } = params;
  const recs: PerformanceRecommendation[] = [];

  // C-tier performance
  const c = byTier["C"];
  if (c && c.trades >= minSampleSize) {
    if (c.avgR < -0.3) {
      recs.push({
        action: c.avgR < -0.7 ? "disable_c_tier" : "tighten_c_tier",
        reason: `C-tier avgR=${c.avgR.toFixed(3)} over ${c.trades} trades. Consider raising AUTO_ENTRY_C_MIN_SCORE.`,
        avgR: c.avgR,
        sampleSize: c.trades,
        urgency: c.avgR < -0.7 ? "high" : "medium",
      });
    }
  }

  // Flat-trend long bucket
  const ftl = byPerformanceBucket["c_flat_trend_long"];
  if (ftl && ftl.trades >= minSampleSize && ftl.avgR < -0.2) {
    recs.push({
      action: "block_flat_trend_long",
      reason: `flat_trend_long avgR=${ftl.avgR.toFixed(3)} over ${ftl.trades} trades. Enable AUTO_ENTRY_REQUIRE_TREND_ALIGNMENT=true.`,
      avgR: ftl.avgR,
      sampleSize: ftl.trades,
      urgency: "medium",
    });
  }

  // Short performance
  const shorts = byDirection["SHORT"];
  if (shorts && shorts.trades >= minSampleSize && shorts.avgR < -0.4) {
    recs.push({
      action: "restrict_shorts",
      reason: `SHORT avgR=${shorts.avgR.toFixed(3)} over ${shorts.trades} trades. Consider raising SHORT score threshold.`,
      avgR: shorts.avgR,
      sampleSize: shorts.trades,
      urgency: shorts.avgR < -0.8 ? "high" : "medium",
    });
  }

  if (recs.length === 0) {
    recs.push({ action: "no_action", reason: "Performance within acceptable bounds.", urgency: "low" });
  }

  return recs;
}
