/**
 * Shared Trading KPIs — Agent Performance Hub
 *
 * Aggregates normalized performance metrics from the trading funnel
 * so all agents can consume consistent KPI data.
 *
 * Sources:
 *   - /api/performance/analytics (realized R, win rate)
 *   - /api/funnel-stats (qualified → seeded → executed)
 *   - /api/funnel-health (signal freshness, latency)
 *   - /api/trades (trade execution details)
 *   - /api/readiness (system health, broker sync)
 *
 * Updated every 60 seconds. Consumed by all agents.
 */

import { redis } from "@/lib/redis";
import { getTtlSeconds, setWithTtl } from "@/lib/redis/ttl";
import { readTodayFunnel } from "@/lib/funnelRedis";
import { readTrades } from "@/lib/tradesStore";
import { extractClosedTrades, buildAnalytics } from "@/lib/performance/tradeStats";
import { buildPortfolioSnapshot } from "@/lib/performance/portfolioSnapshot";
import { readSignals } from "@/lib/jsonDb";
import { getSignalTimestampMs } from "@/lib/signals/since";
import { getEtDateString, getEtDayBoundsMs } from "@/lib/time/etDate";
import { getGuardrailConfig } from "@/lib/autoEntry/guardrails";
import { getAutoEntryEnabledState } from "@/lib/autoEntry/guardrailsStore";
import { fetchBrokerTruth } from "@/lib/broker/truth";
import { isOpenTradeStatus } from "@/lib/trades/protection";
import { auditProtectionIntegrity } from "@/lib/risk/protection-integrity";

// ─── Normalized KPI Types ─────────────────────────────────────────────────────

/**
 * Unified trading performance snapshot.
 * All agents consume from this single source of truth.
 */
export interface SharedTradingKpis {
  // Timestamp
  asOf: string;
  window: string; // "24h", "7d", "30d"

  // ─── Realized Performance ─────────────────────────────────────
  avgRealizedR: number;
  winRate: number;
  lossRate: number;
  profitFactor: number;

  // ─── Execution Funnel ─────────────────────────────────────────
  seededToExecutedPct: number;
  qualifiedToExecutedPct: number;
  qualifiedToSeededPct: number;
  signalToQualifiedPct: number;
  executionRate: number;
  executionLatencySec: number;

  // ─── Signal Quality ────────────────────────────────────────────
  staleSignalPct: number;
  freshSignalPct: number;
  totalSeeds: number;
  duplicateSeedRate: number;

  // ─── Risk Management ──────────────────────────────────────────
  drawdown: number;
  protectionIntegrity: number;
  brokerErrorRate: number;

  // ─── System Health ─────────────────────────────────────────────
  scoringSuccessRate: number;
  positionMismatchCount: number;
  autoEntryEnabled: boolean;

  // ─── Expected vs Actual Impact ────────────────────────────────
  expectedRImpactPending: number;
  actualRImpactRecent: number;

  // ─── Metric health / nullability hints ────────────────────────
  metricStatus?: Record<string, "measured" | "derived" | "unavailable">;
  metricNotes?: string[];

  // ─── Health Flags ─────────────────────────────────────────────
  isCritical: boolean;
  freezeReasons: string[];

  criticalThresholds?: {
    executionRateLow: boolean;
    staleSignalsHigh: boolean;
    latencyHigh: boolean;
    drawdownHigh: boolean;
    brokerErrorsHigh: boolean;
  };
}

/**
 * Metric deltas for tracking trend direction.
 */
export interface ShortTermKpiTrend {
  metric: keyof SharedTradingKpis;
  current: number;
  previous: number;
  changeRate: number; // % change
  trend: "improving" | "stable" | "degrading";
}

// ─── KPI Storage Keys ──────────────────────────────────────────────────────────

const SHARED_KPIS_KEY = "trading:shared-kpis:current";
const SHARED_KPIS_HISTORY_KEY = "trading:shared-kpis:history";
const SHARED_KPIS_TTL_SEC = 300; // 5 minutes

// ─── Default/Empty State ──────────────────────────────────────────────────────

function createEmptyKpis(window = "24h"): SharedTradingKpis {
  return {
    asOf: new Date().toISOString(),
    window,
    avgRealizedR: 0,
    winRate: 0,
    lossRate: 0,
    profitFactor: 0,
    seededToExecutedPct: 0,
    qualifiedToExecutedPct: 0,
    qualifiedToSeededPct: 0,
    signalToQualifiedPct: 0,
    executionRate: 0,
    executionLatencySec: 0,
    staleSignalPct: 0,
    freshSignalPct: 0,
    totalSeeds: 0,
    duplicateSeedRate: 0,
    drawdown: 0,
    protectionIntegrity: 1,
    brokerErrorRate: 0,
    scoringSuccessRate: 0,
    positionMismatchCount: 0,
    autoEntryEnabled: true,
    expectedRImpactPending: 0,
    actualRImpactRecent: 0,
    metricStatus: {
      avgRealizedR: "unavailable",
      winRate: "unavailable",
      executionLatencySec: "unavailable",
      seededToExecutedPct: "unavailable",
      freshSignalPct: "unavailable",
      staleSignalPct: "unavailable",
    },
    metricNotes: ["shared_kpis_unavailable"],
    isCritical: false,
    freezeReasons: [],
    criticalThresholds: {
      executionRateLow: false,
      staleSignalsHigh: false,
      latencyHigh: false,
      drawdownHigh: false,
      brokerErrorsHigh: false,
    },
  };
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch current shared trading KPIs from Redis.
 * Falls back to computed telemetry snapshot when cache is unavailable/stale.
 */
function percent(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function ratio(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return Number((numerator / denominator).toFixed(4));
}

function num(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function minutesAgo(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  return Math.round((Date.now() - ts) / 60000);
}

export async function computeSharedTradingKpis(window = "24h"): Promise<SharedTradingKpis> {
  const metricStatus: Record<string, "measured" | "derived" | "unavailable"> = {};
  const metricNotes: string[] = [];

  const [funnel, tradesRaw, signalsRaw, portfolio, brokerTruth] = await Promise.all([
    readTodayFunnel().catch(() => null),
    readTrades<any>().catch(() => []),
    readSignals().catch(() => []),
    buildPortfolioSnapshot().catch(() => null),
    fetchBrokerTruth().catch(() => ({ error: "broker_truth_fetch_failed", positions: [], openOrders: [] } as any)),
  ]);

  const trades = Array.isArray(tradesRaw) ? tradesRaw : [];
  const closedTrades = extractClosedTrades(trades);
  const analytics = buildAnalytics(closedTrades);

  const todayEt = getEtDateString();
  const { startMs: dayStartMs, endMs: dayEndMs } = getEtDayBoundsMs(todayEt);
  const todaySignals = (Array.isArray(signalsRaw) ? signalsRaw : []).filter((s: any) => {
    const ts = getSignalTimestampMs(s, "createdAt");
    return ts != null && Number.isFinite(ts) && ts >= dayStartMs && ts < dayEndMs;
  });
  const qualifiedSignals = todaySignals.filter((s: any) => s?.qualified === true);
  const staleQualified = qualifiedSignals.filter((s: any) => {
    const ts = getSignalTimestampMs(s, "createdAt");
    return ts != null && Number.isFinite(ts) && (Date.now() - ts) > 10 * 60 * 1000;
  });
  const freshQualified = Math.max(0, qualifiedSignals.length - staleQualified.length);

  const funnelSignals = num((funnel as any)?.signalsReceived, 0);
  const funnelQualified = num((funnel as any)?.qualified, 0);
  const seededFromQualified =
    num((funnel as any)?.seedFromQualifiedLong, 0) +
    num((funnel as any)?.seedFromQualifiedShort, 0);
  const executedFromSeeded =
    num((funnel as any)?.executeFromSeededLong, 0) +
    num((funnel as any)?.executeFromSeededShort, 0);

  const signalToQualifiedPct = percent(funnelQualified, funnelSignals);
  const qualifiedToSeededPct = percent(seededFromQualified, funnelQualified);
  const seededToExecutedPct = percent(executedFromSeeded, Math.max(seededFromQualified, num((funnel as any)?.seedCreatedCount, 0)));
  const qualifiedToExecutedPct = percent(executedFromSeeded, funnelQualified);

  metricStatus.signalToQualifiedPct = funnelSignals > 0 ? "measured" : "unavailable";
  metricStatus.qualifiedToSeededPct = funnelQualified > 0 ? "measured" : "unavailable";
  metricStatus.seededToExecutedPct = (seededFromQualified > 0 || num((funnel as any)?.seedCreatedCount, 0) > 0) ? "measured" : "unavailable";
  metricStatus.qualifiedToExecutedPct = funnelQualified > 0 ? "measured" : "unavailable";

  const scoredCount = num((funnel as any)?.gptScored, 0);
  const scoringSuccessRate = ratio(funnelQualified, scoredCount);
  metricStatus.scoringSuccessRate = scoredCount > 0 ? "measured" : "unavailable";

  const freshSignalPct = percent(freshQualified, qualifiedSignals.length);
  const staleSignalPct = percent(staleQualified.length, qualifiedSignals.length);
  metricStatus.freshSignalPct = qualifiedSignals.length > 0 ? "measured" : "unavailable";
  metricStatus.staleSignalPct = qualifiedSignals.length > 0 ? "measured" : "unavailable";

  const executedTrades = trades.filter((t: any) => typeof t?.executedAt === "string" && typeof t?.createdAt === "string");
  const latencySamples = executedTrades
    .map((t: any) => {
      const created = Date.parse(String(t.createdAt));
      const executed = Date.parse(String(t.executedAt));
      if (!Number.isFinite(created) || !Number.isFinite(executed) || executed < created) return null;
      return (executed - created) / 1000;
    })
    .filter((v: number | null): v is number => v != null);
  const executionLatencySec = latencySamples.length > 0
    ? Number((latencySamples.reduce((a, b) => a + b, 0) / latencySamples.length).toFixed(2))
    : 0;
  metricStatus.executionLatencySec = latencySamples.length > 0 ? "measured" : "unavailable";

  const wins = analytics.totals.wins;
  const losses = analytics.totals.losses;
  const lossRate = analytics.totals.trades > 0 ? Number((losses / analytics.totals.trades).toFixed(4)) : 0;
  metricStatus.avgRealizedR = analytics.totals.trades > 0 ? "measured" : "unavailable";
  metricStatus.winRate = analytics.totals.trades > 0 ? "measured" : "unavailable";

  let protectionIntegrity = 1;
  if (!brokerTruth?.error) {
    const audit = auditProtectionIntegrity({
      openTrades: trades.filter((t: any) => isOpenTradeStatus(t?.status)).map((t: any) => ({
        id: String(t.id || ""),
        ticker: String(t.ticker || ""),
        side: String(t.side || ""),
        status: String(t.status || ""),
        stopOrderId: t.stopOrderId || t.alpacaStopOrderId,
      })),
      brokerPositions: Array.isArray(brokerTruth.positions) ? brokerTruth.positions : [],
      brokerOrders: Array.isArray(brokerTruth.openOrders) ? brokerTruth.openOrders : [],
    });
    const totalProtectionChecks = (audit.protectedCount ?? 0) + (audit.incidentCount ?? 0);
    protectionIntegrity = totalProtectionChecks > 0 ? Number(((audit.protectedCount ?? 0) / totalProtectionChecks).toFixed(4)) : 1;
    metricStatus.protectionIntegrity = "measured";
  } else {
    metricStatus.protectionIntegrity = "unavailable";
    metricNotes.push("protection_integrity_unavailable_broker_truth_error");
  }

  const config = getGuardrailConfig();
  const autoEntryState = await getAutoEntryEnabledState(config).catch(() => ({ enabled: config.enabled, reason: "guardrail_state_unavailable" }));
  const readiness = {
    autoEntryEnabled: Boolean(autoEntryState.enabled),
    scannerHealthy: num((funnel as any)?.scansRun, 0) > 0 || minutesAgo((funnel as any)?.lastScanAt) === null,
    scoringHealthy: scoredCount > 0 || funnelSignals === 0,
    brokerHealthy: !brokerTruth?.error,
    reason: autoEntryState.reason ?? null,
  };

  if (metricStatus.signalToQualifiedPct === "unavailable") metricNotes.push("signal_to_qualified_unavailable_no_signals");
  if (metricStatus.qualifiedToSeededPct === "unavailable") metricNotes.push("qualified_to_seeded_unavailable_no_qualified_signals");
  if (metricStatus.seededToExecutedPct === "unavailable") metricNotes.push("seeded_to_executed_unavailable_no_seeded_signals");
  if (metricStatus.avgRealizedR === "unavailable") metricNotes.push("performance_unavailable_no_closed_trades");
  if (metricStatus.freshSignalPct === "unavailable") metricNotes.push("freshness_unavailable_no_qualified_signals_today");

  const positionMismatchCount = brokerTruth?.error
    ? 0
    : Math.max(0, Math.abs(num((brokerTruth?.positionsCount ?? 0), 0) - trades.filter((t: any) => isOpenTradeStatus(t?.status)).length));

  const brokerErrorRate = brokerTruth?.error ? 1 : 0;
  const drawdown = portfolio?.maxDrawdown != null ? Number((-(Math.abs(num(portfolio.maxDrawdown, 0)) / 1000)).toFixed(3)) : 0;

  const expectedRImpactPending = 0;
  const actualRImpactRecent = Number((analytics.totals.realizedR || 0).toFixed(3));

  const freeze = calculateFreezeConditions({
    ...createEmptyKpis(window),
    avgRealizedR: Number((analytics.totals.avgR || 0).toFixed(3)),
    winRate: Number(((analytics.totals.winRate || 0) / 100).toFixed(4)),
    lossRate,
    profitFactor: analytics.totals.losses > 0 ? Number((analytics.totals.wins / analytics.totals.losses).toFixed(3)) : analytics.totals.wins > 0 ? 999 : 0,
    seededToExecutedPct,
    qualifiedToExecutedPct,
    qualifiedToSeededPct,
    signalToQualifiedPct,
    executionRate: qualifiedToExecutedPct,
    executionLatencySec,
    staleSignalPct,
    freshSignalPct,
    totalSeeds: seededFromQualified,
    duplicateSeedRate: ratio(num((funnel as any)?.seedSkippedDuplicate, 0), Math.max(num((funnel as any)?.seedTotalCandidates, 0), 1)),
    drawdown,
    protectionIntegrity,
    brokerErrorRate,
    scoringSuccessRate,
    positionMismatchCount,
    autoEntryEnabled: readiness.autoEntryEnabled,
    expectedRImpactPending,
    actualRImpactRecent,
    metricStatus,
    metricNotes,
    isCritical: false,
    freezeReasons: [],
  });

  return {
    asOf: new Date().toISOString(),
    window,
    avgRealizedR: Number((analytics.totals.avgR || 0).toFixed(3)),
    winRate: Number(((analytics.totals.winRate || 0) / 100).toFixed(4)),
    lossRate,
    profitFactor: analytics.totals.losses > 0 ? Number((analytics.totals.wins / analytics.totals.losses).toFixed(3)) : analytics.totals.wins > 0 ? 999 : 0,
    seededToExecutedPct,
    qualifiedToExecutedPct,
    qualifiedToSeededPct,
    signalToQualifiedPct,
    executionRate: qualifiedToExecutedPct,
    executionLatencySec,
    staleSignalPct,
    freshSignalPct,
    totalSeeds: seededFromQualified,
    duplicateSeedRate: ratio(num((funnel as any)?.seedSkippedDuplicate, 0), Math.max(num((funnel as any)?.seedTotalCandidates, 0), 1)),
    drawdown,
    protectionIntegrity,
    brokerErrorRate,
    scoringSuccessRate,
    positionMismatchCount,
    autoEntryEnabled: readiness.autoEntryEnabled,
    expectedRImpactPending,
    actualRImpactRecent,
    metricStatus,
    metricNotes: readiness.reason ? [...metricNotes, `auto_entry_reason:${readiness.reason}`] : metricNotes,
    isCritical: freeze.shouldFreeze,
    freezeReasons: freeze.reasons,
    criticalThresholds: {
      executionRateLow: seededToExecutedPct < 40,
      staleSignalsHigh: staleSignalPct > 50,
      latencyHigh: executionLatencySec > 300,
      drawdownHigh: drawdown < -5,
      brokerErrorsHigh: brokerErrorRate > 0.1,
    },
  };
}

export async function getSharedTradingKpis(): Promise<SharedTradingKpis> {
  if (!redis) {
    return computeSharedTradingKpis().catch(() => createEmptyKpis());
  }

  try {
    const raw = await redis.get<string>(SHARED_KPIS_KEY);
    const parsed = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
    if (parsed && typeof parsed === "object" && "avgRealizedR" in parsed && "asOf" in parsed) {
      const asOfMs = Date.parse(String((parsed as Record<string, unknown>).asOf || ""));
      const isFresh = Number.isFinite(asOfMs) && (Date.now() - asOfMs) <= SHARED_KPIS_TTL_SEC * 1000;
      if (isFresh) return parsed as SharedTradingKpis;
    }

    const computed = await computeSharedTradingKpis();
    await updateSharedTradingKpis(computed).catch(() => null);
    return computed;
  } catch {
    return computeSharedTradingKpis().catch(() => createEmptyKpis());
  }
}

/**
 * Write updated KPIs to Redis with TTL.
 */
export async function updateSharedTradingKpis(
  kpis: SharedTradingKpis,
): Promise<void> {
  if (!redis) return;

  try {
    // Update current
    await setWithTtl(
      redis,
      SHARED_KPIS_KEY,
      JSON.stringify(kpis),
      SHARED_KPIS_TTL_SEC,
    );

    // Append to history for trend analysis
    const history = await redis.lrange<SharedTradingKpis>(
      SHARED_KPIS_HISTORY_KEY,
      0,
      -1,
    );
    const newHistory = [kpis, ...(history || []).slice(0, 1439)]; // Keep 24 hours
    await redis.del(SHARED_KPIS_HISTORY_KEY);
    if (newHistory.length > 0) {
      await redis.rpush(
        SHARED_KPIS_HISTORY_KEY,
        ...newHistory.map((h) => JSON.stringify(h)),
      );
      await redis.expire(SHARED_KPIS_HISTORY_KEY, 86400); // 24h TTL
    }
  } catch {
    // non-fatal
  }
}

/**
 * Calculate critical work freeze conditions.
 *
 * If any of these thresholds are crossed, only CRITICAL, EXECUTION,
 * RISK, and PERFORMANCE tasks are allowed. UI and cosmetic work is frozen.
 */
export function calculateFreezeConditions(kpis: SharedTradingKpis): {
  shouldFreeze: boolean;
  reasons: string[];
  allowedWorkTypes: string[];
} {
  const reasons: string[] = [];

  if (kpis.seededToExecutedPct < 40) {
    reasons.push(`Execution rate critical: ${kpis.seededToExecutedPct.toFixed(0)}% < 40%`);
  }

  if (kpis.freshSignalPct < 50) {
    reasons.push(`Fresh signal rate critical: ${kpis.freshSignalPct.toFixed(0)}% < 50%`);
  }

  if (kpis.executionLatencySec > 300) {
    reasons.push(`Execution latency critical: ${kpis.executionLatencySec}s > 300s`);
  }

  if (kpis.drawdown < -5) {
    reasons.push(`Drawdown critical: ${kpis.drawdown.toFixed(2)}R < -5R`);
  }

  if (kpis.brokerErrorRate > 0.1) {
    reasons.push(`Broker errors critical: ${(kpis.brokerErrorRate * 100).toFixed(0)}% > 10%`);
  }

  const shouldFreeze = reasons.length > 0;

  return {
    shouldFreeze,
    reasons,
    allowedWorkTypes: shouldFreeze
      ? ["EXECUTION", "RISK", "PERFORMANCE", "CRITICAL_ENGINEERING"]
      : ["EXECUTION", "RISK", "PERFORMANCE", "FEATURE", "OPTIMIZATION", "COSMETIC"],
  };
}

/**
 * Compute trend from KPI history.
 */
export async function computeKpiTrends(
  metric: keyof SharedTradingKpis,
  depth = 10,
): Promise<ShortTermKpiTrend | null> {
  if (!redis) return null;

  try {
    const history = await redis.lrange<SharedTradingKpis>(
      SHARED_KPIS_HISTORY_KEY,
      0,
      depth - 1,
    );

    if (!history || history.length < 2) return null;

    const current = (history[0] as unknown as Record<string, number>)?.[metric as string] ?? 0;
    const previous = (history[1] as unknown as Record<string, number>)?.[metric as string] ?? 0;

    if (previous === 0) {
      return {
        metric,
        current,
        previous,
        changeRate: current === 0 ? 0 : Infinity,
        trend: current > previous ? "improving" : "degrading",
      };
    }

    const changeRate = ((current - previous) / Math.abs(previous)) * 100;
    const trend = Math.abs(changeRate) < 2 ? "stable" : changeRate > 0 ? "improving" : "degrading";

    return {
      metric,
      current,
      previous,
      changeRate,
      trend,
    };
  } catch {
    return null;
  }
}

/**
 * Build a human-readable summary of current trading KPI health.
 */
export function summarizeKpiHealth(kpis: SharedTradingKpis): string {
  const parts: string[] = [
    `Realized R: ${kpis.avgRealizedR.toFixed(2)}`,
    `Win rate: ${(kpis.winRate * 100).toFixed(0)}%`,
    `Execution: ${kpis.executionRate.toFixed(0)}%`,
    `Latency: ${kpis.executionLatencySec.toFixed(0)}s`,
    `Fresh signals: ${kpis.freshSignalPct.toFixed(0)}%`,
  ];

  if (kpis.positionMismatchCount > 0) {
    parts.push(`⚠ Position mismatch: ${kpis.positionMismatchCount}`);
  }

  if (kpis.isCritical) {
    parts.push(`🔴 CRITICAL`);
  }

  return parts.join(" | ");
}

/**
 * Detect critical KPI violations that require agent attention.
 */
export function detectKpiViolations(kpis: SharedTradingKpis): string[] {
  const violations: string[] = [];

  if (kpis.avgRealizedR < -0.5) {
    violations.push(`avgR critical (${kpis.avgRealizedR.toFixed(2)} < -0.5)`);
  }

  if (kpis.executionLatencySec > 300) {
    violations.push(`latency critical (${kpis.executionLatencySec.toFixed(0)}s > 300s)`);
  }

  if (kpis.staleSignalPct > 50) {
    violations.push(`stale signals critical (${kpis.staleSignalPct.toFixed(0)}% > 50%)`);
  }

  if (kpis.seededToExecutedPct < 40) {
    violations.push(`execution rate critical (${kpis.seededToExecutedPct.toFixed(0)}% < 40%)`);
  }

  if (kpis.brokerErrorRate > 0.1) {
    violations.push(`broker errors critical (${(kpis.brokerErrorRate * 100).toFixed(0)}% > 10%)`);
  }

  if (kpis.positionMismatchCount > 5) {
    violations.push(`position mismatches high (${kpis.positionMismatchCount} > 5)`);
  }

  return violations;
}
