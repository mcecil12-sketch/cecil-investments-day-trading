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

  /** Average realized R across all closed trades */
  avgRealizedR: number; // -2 to +2

  /** Win rate: (wins / closed trades) % */
  winRate: number; // 0–1

  /** Loss rate: (losses / closed trades) % */
  lossRate: number; // 0–1

  /** Profit factor: (total wins / total losses) or 0 if no losses */
  profitFactor: number;

  // ─── Execution Funnel ─────────────────────────────────────────

  /** (seeded + executed) / qualified * 100 */
  seededToExecutedPct: number; // 0–100

  /** (executed) / (seeded + executed) * 100 */
  qualifiedToExecutedPct: number; // 0–100

  /** Execution rate = executed / qualified * 100 */
  executionRate: number; // 0–100

  /** Average time from qualified signal → broker execution */
  executionLatencySec: number; // seconds

  // ─── Signal Quality ────────────────────────────────────────────

  /** % of active signals older than 10 minutes */
  staleSignalPct: number; // 0–100

  /** % of signals that are fresh (< 10 min) */
  freshSignalPct: number; // 0–100

  /** Total seed requests in last window */
  totalSeeds: number;

  /** Duplicate seed rate (reseedsProposed / seeds) */
  duplicateSeedRate: number; // 0–1

  // ─── Risk Management ──────────────────────────────────────────

  /** Realized drawdown: max cumulative loss from peak */
  drawdown: number;

  /** Stop protection integrity: % of trades with valid stops */
  protectionIntegrity: number; // 0–1

  /** Broker error rate: failed orders / total orders */
  brokerErrorRate: number; // 0–1

  // ─── System Health ─────────────────────────────────────────────

  /** AI scoring success rate: (qualified / scanned) */
  scoringSuccessRate: number; // 0–1

  /** Position mismatch: DB trades vs Broker positions */
  positionMismatchCount: number;

  /** Auto-entry system enabled */
  autoEntryEnabled: boolean;

  // ─── Expected vs Actual Impact ────────────────────────────────

  /** Agents' expected R improvement from active tasks */
  expectedRImpactPending: number;

  /** Realized R improvement from completed tasks */
  actualRImpactRecent: number;

  // ─── Health Flags ─────────────────────────────────────────────

  /** System is in critical trading condition */
  isCritical: boolean;

  /** Flags preventing non-critical work */
  freezeReasons: string[];

  criticalThresholds?: {
    executionRateLow: boolean; // < 40%
    staleSignalsHigh: boolean; // > 50%
    latencyHigh: boolean; // > 300s
    drawdownHigh: boolean; // realized dd > -5R
    brokerErrorsHigh: boolean; // > 10% error rate
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
 * Falls back to empty state if not available.
 */
export async function getSharedTradingKpis(): Promise<SharedTradingKpis> {
  if (!redis) {
    return createEmptyKpis();
  }

  try {
    const raw = await redis.get<string>(SHARED_KPIS_KEY);
    if (!raw) {
      return createEmptyKpis();
    }

    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === "object" && "avgRealizedR" in parsed) {
      return parsed as SharedTradingKpis;
    }

    return createEmptyKpis();
  } catch {
    return createEmptyKpis();
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
