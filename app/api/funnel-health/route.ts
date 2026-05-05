import { NextResponse } from "next/server";
import { fetchAlpacaClock } from "@/lib/alpacaClock";
import { fetchBrokerTruth } from "@/lib/broker/truth";
import { getGuardrailConfig } from "@/lib/autoEntry/guardrails";
import { getGuardrailsState } from "@/lib/autoEntry/guardrailsStore";
import { readTodayFunnel } from "@/lib/funnelRedis";
import { getEtDateString, getEtDayBoundsMs, isTimestampInEtDay } from "@/lib/time/etDate";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import { readSignals } from "@/lib/jsonDb";
import { auditProtectionIntegrity } from "@/lib/risk/protection-integrity";
import { isOpenTradeStatus } from "@/lib/trades/protection";
import { getSignalTimestampMs } from "@/lib/signals/since";
import { selectCanonicalOpenTrades } from "@/lib/trades/canonicalOpenBySymbol";
import { evaluateTradeProtectionNow } from "@/lib/risk/protection-truth";
import { readLatestSeedRunTelemetry } from "@/lib/autoEntry/seedTelemetry";
import { repairStaleTerminalTrades } from "@/lib/trades/lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

type Incident = {
  code: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  message: string;
  context: Record<string, unknown>;
  /** Intent classification for distinguishing system failures from normal quality gating */
  incidentType?: "SYSTEM_BROKEN" | "QUALITY_FILTERING" | "EXECUTION_SELECTIVITY" | "TRUE_EXECUTION_BLOCK";
  /** Human-readable recommended action for ops/agent */
  recommendedAction?: string;
};

type FunnelScore = {
  value: number; // 0-100
  grade: string; // A, B, C, D, F
  reason: string;
};

type FunnelHealthResponse = {
  ok: boolean;
  dateET: string;
  marketOpen: boolean;
  funnel: {
    candidates: number;
    signalsReceived: number;
    scored: number;
    qualified: number;
    seeded: number;
    executed: number;
    seededButNotExecuted?: number;
  };
  capacity: {
    currentOpenPositions: number;
    maxOpenPositions: number;
    entriesToday: number;
    maxEntriesPerDay: number;
    remainingPositionSlots: number;
    remainingEntriesToday: number;
    utilization: number | null; // 0-100%
  };
  conversion: {
    signalToQualified: number | null;
    qualifiedToSeeded: number | null;
    seededToExecuted: number | null;
  };
  qualifiedButNotSeeded?: number;
  freshQualifiedSignals?: number;
  staleQualifiedSignals?: number;
  qualifiedToSeedLatencyMaxMs?: number | null;
  qualifiedToSeedLatencyAvgMs?: number | null;
  seedSlaBreached?: boolean;
  seedSlaBreachSignals?: Array<{
    signalId: string;
    symbol: string;
    createdAt: string | null;
    seedEvaluatedAt: string | null;
    ageMs: number | null;
    staleThresholdUsedMs: number;
  }>;
  seedSkipReasonBreakdown?: Record<string, number>;
  lastSeedRunAt?: string | null;
  lastSeedRunSource?: string | null;
  lastSeedRunId?: string | null;
  score: FunnelScore;
  incidents: Incident[];
  activeMalformedPendingCount?: number;
  terminalMalformedCount?: number;
  staleTerminalRepairedCount?: number;
  timestamps?: {
    lastSeedAt?: string | null;
    lastExecuteAt?: string | null;
    minsSinceLastSeed?: number | null;
    minsSinceLastExecute?: number | null;
  };
  funnelFlowDiagnostics?: {
    stoppedAt: string;
    stoppedReason: string;
    stages: Record<string, unknown>;
    scanSkipsByMode: Record<string, number>;
    scanRunsByMode: Record<string, number>;
  };
  brokerReconciliation?: {
    brokerIsFlat: boolean;
    staleMismatchTickers: string[];
    message: string;
  };
  /** Per-trade flatten lifecycle diagnostics for operator/agent visibility */
  protectionDetail?: {
    tickers: string[];
    perTrade: Array<{
      tradeId: string;
      symbol: string;
      isCurrentlyProtected: boolean;
      brokerPositionExists: boolean;
      brokerStopDetected: boolean;
      activeCloseOrderDetected: boolean;
      activeCloseOrderId?: string;
      activeCloseOrderStatus?: string;
      brokerPositionQty: number;
      residualQty: number;
      flattenLifecycleState: string;
      recoveryState: string;
      nextAction: string;
    }>;
  };
  /** Skip reason breakdown for seeded trades that were not executed this session */
  executeSkipReasonBreakdown?: Record<string, number>;
  /** Number of seeded trades that aged out before execution */
  staleExpiredCount?: number;
  /** Timing stats for trades that were archived as stale/expired */
  staleTimingStats?: {
    count: number;
    avgAgeMs: number;
    thresholdMs: number | null;
    overThresholdPct: number | null;
  } | null;
  /** Execute blocker metrics — present when any pending trades were rejected */
  executeBlockerMetrics?: {
    activeMalformedPendingCount: number;
    terminalMalformedCount: number;
    staleTerminalRepairedCount?: number;
    rescoreRequiredCount: number;
    scoreThresholdBlockedCount: number;
    priceDriftSkippedCount: number;
    stalePendingCount: number;
    executeSlaBreached: boolean;
  };
  /** True when the final execution gate is actively blocking entries during market hours */
  finalEntryGateBlocked?: boolean;
  /** Primary reason the final entry gate is blocked */
  topFinalGateReason?: "price_drift" | "overlay_block" | "stale_qualified_signal" | "no_pending" | null;
  /** Operator-readable message for the top blocked gate reason */
  finalGateActionableMessage?: string | null;
  error?: string;
  // DEBUG: Temporary field for attribution verification (can be removed later)
  _debug?: {
    scope: string;
    etDayBounds?: {
      startMs: number;
      endMs: number;
      startIso: string;
      endIso: string;
    };
    sources: Record<string, string>;
    rawCounts: Record<string, number>;
    sampleSignals?: Array<Record<string, unknown>>;
  };
};

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function num(val: unknown): number {
  return typeof val === "number" && Number.isFinite(val) ? val : 0;
}

function safePercent(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10; // e.g., 75.3%
}

function minutesSince(iso?: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.round((Date.now() - t) / 60000);
}

// -------------------------------------------------------------------------
// Incident Detection Rules
// -------------------------------------------------------------------------

function detectIncidents(params: {
  marketOpen: boolean;
  candidates: number;
  qualified: number;
  freshQualifiedSignals: number;
  staleQualifiedSignals: number;
  seeded: number;
  executed: number;
  remainingPositionSlots: number;
  minsSinceLastExecute: number | null;
  seedSlaBreached: boolean;
  noAutoPendingSkips: number;
  protectionMissingTickers: string[];
  activeMalformedPendingCount: number;
  openProtectionBlockerCount: number;
  /** Count of AUTO_PENDING trades with no terminal executeOutcome — truly fresh unresolved. */
  freshUnresolvedPendingCount: number;
  /** Count of AUTO_PENDING trades older than the stale threshold during market hours. */
  staleActivePendingCount: number;
  /** Count of seeds blocked by C-tier quality gates (intentional filtering). */
  cTierQualityBlockCount?: number;
  /** Count of seeds blocked by quality-based thresholds in general (below_threshold). */
  qualityThresholdBlockCount?: number;
}): Incident[] {
  const incidents: Incident[] = [];
  const { 
    marketOpen, 
    candidates, 
    qualified,
    freshQualifiedSignals,
    staleQualifiedSignals,
    seeded,
    executed,
    remainingPositionSlots,
    minsSinceLastExecute,
    seedSlaBreached,
    noAutoPendingSkips,
    protectionMissingTickers,
    activeMalformedPendingCount,
    openProtectionBlockerCount,
    freshUnresolvedPendingCount,
    staleActivePendingCount,
    cTierQualityBlockCount = 0,
    qualityThresholdBlockCount = 0,
  } = params;

  const totalQualityBlocks = cTierQualityBlockCount + qualityThresholdBlockCount;

  // CRITICAL: Protection missing on open trades
  if (protectionMissingTickers.length > 0) {
    incidents.push({
      code: "PROTECTION_MISSING",
      severity: "CRITICAL",
      incidentType: "SYSTEM_BROKEN",
      recommendedAction: "Check stop protection logic immediately. Open positions may be unprotected.",
      message: `${protectionMissingTickers.length} open trade(s) missing stop protection: ${protectionMissingTickers.slice(0, 5).join(", ")}${protectionMissingTickers.length > 5 ? "..." : ""}`,
      context: { tickers: protectionMissingTickers, count: protectionMissingTickers.length },
    });
  }

  // 1) UNDERUTILIZED_FUNNEL: many candidates but seeding below capacity
  const minSeededExpected = Math.min(2, remainingPositionSlots);
  if (candidates > 50 && seeded < minSeededExpected) {
    incidents.push({
      code: "UNDERUTILIZED_FUNNEL",
      severity: "HIGH",
      incidentType: "SYSTEM_BROKEN",
      recommendedAction: "High signal count but few seeded. Check scoring thresholds or capacity constraints.",
      message: `High candidate count (${candidates}) but only ${seeded} seeded (capacity allows ${remainingPositionSlots}). Check scoring thresholds or capacity constraints.`,
      context: { candidates, seeded, remainingPositionSlots, minSeededExpected },
    });
  }

  // 2) QUALIFIED_NOT_SEEDED: qualified signals exist but none seeded
  // Distinguish quality-gate filtering from a true system block.
  if (qualified > 10 && seeded === 0) {
    const mostlyQualityBlocked = totalQualityBlocks >= qualified * 0.8;
    incidents.push({
      code: "QUALIFIED_NOT_SEEDED",
      severity: mostlyQualityBlocked ? "MEDIUM" : "HIGH",
      incidentType: mostlyQualityBlocked ? "QUALITY_FILTERING" : "TRUE_EXECUTION_BLOCK",
      recommendedAction: mostlyQualityBlocked
        ? "Quality gates blocking C-tier signals intentionally. Verify A/B signals are not also blocked."
        : "Qualified signals exist but seeding stalled. Check seed route auth, capacity limits, and skip reasons.",
      message: mostlyQualityBlocked
        ? `${qualified} qualified signals blocked by quality gates (${totalQualityBlocks} quality blocks). Intentional filtering — verify A/B signals pass.`
        : `${qualified} qualified signals but 0 seeded. Check seeding logic or capacity constraints.`,
      context: { qualified, seeded, cTierQualityBlockCount, qualityThresholdBlockCount, totalQualityBlocks },
    });
  }

  if (marketOpen && seedSlaBreached) {
    incidents.push({
      code: "SEED_SLA_BREACH",
      severity: "CRITICAL",
      incidentType: "SYSTEM_BROKEN",
      recommendedAction: "Seed cron may not be running. Check cron logs.",
      message: `Qualified-to-seed latency SLA breached with freshQualifiedSignals=${freshQualifiedSignals} and staleQualifiedSignals=${staleQualifiedSignals}.`,
      context: { qualified, freshQualifiedSignals, staleQualifiedSignals },
    });
  }

  if (marketOpen && freshQualifiedSignals > 0 && seeded === 0 && noAutoPendingSkips > 0) {
    incidents.push({
      code: "NO_AUTO_PENDING_WITH_FRESH_QUALIFIED",
      severity: "CRITICAL",
      incidentType: "TRUE_EXECUTION_BLOCK",
      recommendedAction: "Fresh A/B signals exist but not seeding. Check seed route auth and capacity.",
      message: `Fresh qualified signals exist but execute is skipping no-auto-pending (count=${noAutoPendingSkips}).`,
      context: { freshQualifiedSignals, seeded, noAutoPendingSkips },
    });
  }

  // EXECUTE_BLOCKER: only unresolved active blockers should count.
  // Excludes terminal ERROR/ARCHIVED/CLOSED and any trade with closedAt set.
  if (marketOpen && (activeMalformedPendingCount > 0 || openProtectionBlockerCount > 0)) {
    incidents.push({
      code: "EXECUTE_BLOCKER",
      severity: "CRITICAL",
      incidentType: "SYSTEM_BROKEN",
      recommendedAction: "Seeded trades malformed at execute. Check payload normalization in execute route.",
      message: `Active execute blockers detected: malformedPending=${activeMalformedPendingCount}, openProtectionBlockers=${openProtectionBlockerCount}.`,
      context: {
        seeded,
        executed,
        activeMalformedPendingCount,
        openProtectionBlockerCount,
        remainingPositionSlots,
      },
    });
  }

  // 3) SEED_NOT_EXECUTED: fresh AUTO_PENDING trades exist with no resolved outcome (market open)
  // Only fire when there are actually unresolved pending trades — not just because historical
  // closed/archived records exist in the seeded count.
  if (freshUnresolvedPendingCount > 0 && executed === 0 && marketOpen) {
    incidents.push({
      code: "SEED_NOT_EXECUTED",
      severity: activeMalformedPendingCount > 0 ? "CRITICAL" : "MEDIUM",
      incidentType: "EXECUTION_SELECTIVITY",
      recommendedAction: "Pending trades not yet executed. Check execute cron and broker connectivity.",
      message: `${freshUnresolvedPendingCount} fresh pending trade(s) not yet executed. Check execute route or broker integration.`,
      context: { seeded, executed, freshUnresolvedPendingCount, marketOpen, activeMalformedPendingCount },
    });
  }

  // 4) NO_EXECUTION_ACTIVITY: market open AND there is work to do (AUTO_PENDING trades or fresh signals)
  //    BUT no recent execute route activity. Only raise if the execute cron should have done something.
  const hasWorkToDo = freshUnresolvedPendingCount > 0 || freshQualifiedSignals > 0;
  if (marketOpen && hasWorkToDo && minsSinceLastExecute !== null && minsSinceLastExecute > 20) {
    incidents.push({
      code: "NO_EXECUTION_ACTIVITY",
      severity: "MEDIUM",
      incidentType: "SYSTEM_BROKEN",
      recommendedAction: "Execute cron may not be running. Check execute route logs.",
      message: `No execution activity for ${minsSinceLastExecute} minutes during market hours with work to do (${freshUnresolvedPendingCount} AUTO_PENDING, ${freshQualifiedSignals} fresh signals).`,
      context: { minsSinceLastExecute, marketOpen, freshUnresolvedPendingCount, freshQualifiedSignals },
    });
  }

  // 5) STALE_AUTO_PENDING: AUTO_PENDING trades older than stale threshold still present during market hours.
  // These should have been archived by the execute route's stale check. Indicates execute is not running
  // or the stale threshold config is missing.
  if (marketOpen && staleActivePendingCount > 0) {
    incidents.push({
      code: "STALE_AUTO_PENDING",
      severity: "HIGH",
      incidentType: "SYSTEM_BROKEN",
      recommendedAction: "Execute stale-check not archiving old pending trades. Execute route may not be running.",
      message: `${staleActivePendingCount} AUTO_PENDING trade(s) exceeded max pending age during market hours without being archived. Execute stale-check may not be running.`,
      context: { staleActivePendingCount, marketOpen },
    });
  }

  return incidents;
}

// -------------------------------------------------------------------------
// Funnel Score Calculation
// -------------------------------------------------------------------------

function computeFunnelScore(params: {
  signalToQualified: number | null;
  qualifiedToSeeded: number | null;
  seededToExecuted: number | null;
  capacityUtilization: number | null;
  incidentCount: number;
  criticalIncidents: number;
  highIncidents: number;
}): FunnelScore {
  const {
    signalToQualified,
    qualifiedToSeeded,
    seededToExecuted,
    capacityUtilization,
    incidentCount,
    criticalIncidents,
    highIncidents,
  } = params;

  let score = 100;
  const reasons: string[] = [];

  // Penalize for critical incidents (-40 each)
  if (criticalIncidents > 0) {
    score -= criticalIncidents * 40;
    reasons.push(`${criticalIncidents} critical incident(s)`);
  }

  // Penalize for high incidents (-15 each)
  if (highIncidents > 0) {
    score -= highIncidents * 15;
    reasons.push(`${highIncidents} high-severity incident(s)`);
  }

  // Penalize for low conversion rates
  if (signalToQualified !== null && signalToQualified < 10) {
    score -= 10;
    reasons.push(`low signal→qualified (${signalToQualified}%)`);
  }

  if (qualifiedToSeeded !== null && qualifiedToSeeded < 20) {
    score -= 15;
    reasons.push(`low qualified→seeded (${qualifiedToSeeded}%)`);
  }

  if (seededToExecuted !== null && seededToExecuted < 50) {
    score -= 10;
    reasons.push(`low seeded→executed (${seededToExecuted}%)`);
  }

  // Penalize for low capacity utilization
  if (capacityUtilization !== null && capacityUtilization < 30) {
    score -= 10;
    reasons.push(`low capacity utilization (${capacityUtilization}%)`);
  }

  // Clamp score
  score = Math.max(0, Math.min(100, score));

  // Grade
  let grade: string;
  if (score >= 90) grade = "A";
  else if (score >= 75) grade = "B";
  else if (score >= 60) grade = "C";
  else if (score >= 40) grade = "D";
  else grade = "F";

  return {
    value: Math.round(score),
    grade,
    reason: reasons.length > 0 ? reasons.join("; ") : "healthy",
  };
}

// -------------------------------------------------------------------------
// Main Handler
// -------------------------------------------------------------------------

export async function GET() {
  const dateET = getEtDateString();
  
  try {
    // Parallel fetch all required data
    const [clock, brokerTruth, guardConfig, guardState, funnelData, allTrades, allSignals, lastSeedRun] = await Promise.all([
      fetchAlpacaClock().catch(() => ({ is_open: false } as { is_open: boolean })),
      fetchBrokerTruth(),
      Promise.resolve(getGuardrailConfig()),
      getGuardrailsState(dateET),
      readTodayFunnel(),
      readTrades<any>().catch(() => []),
      readSignals().catch(() => []),
      readLatestSeedRunTelemetry(dateET),
    ]);

    const marketOpen = Boolean(clock?.is_open);
    const staleRepairNow = new Date().toISOString();
    const staleTerminalRepair = repairStaleTerminalTrades(allTrades || [], staleRepairNow);
    const staleTerminalRepairedCount = staleTerminalRepair.staleTerminalRepairedCount;
    const tradesForMetrics = staleTerminalRepair.trades;
    if (staleTerminalRepairedCount > 0) {
      await writeTrades(tradesForMetrics);
    }

    // -------------------------------------------------------------------------
    // CONSISTENT ET-TODAY FILTERING
    // All funnel stages use the same dateET filter for coherent attribution
    // Uses shared ET-day utilities for correct timezone handling
    // -------------------------------------------------------------------------

    const { startMs: dayStartMs, endMs: dayEndMs } = getEtDayBoundsMs(dateET);

    // Helper to check if a signal is from today (ET timezone) using robust timestamp parsing
    const isSignalToday = (signal: any): boolean => {
      if (!signal) return false;
      try {
        const tsMs = getSignalTimestampMs(signal, "createdAt");
        if (!tsMs || isNaN(tsMs)) return false;
        return tsMs >= dayStartMs && tsMs < dayEndMs;
      } catch {
        return false;
      }
    };

    // -------------------------------------------------------------------------
    // Funnel Metrics - CONSISTENT SOURCES
    // -------------------------------------------------------------------------

    // CANDIDATES: from funnelStats (scanner-attributed, same ET-day)
    const candidates = num(funnelData.candidatesFound);

    // SIGNALS: Filter by robust timestamp for ET-today
    const todaySignals = (allSignals || []).filter(isSignalToday);
    const signalsReceived = todaySignals.length;
    const scored = todaySignals.filter((s: any) => s?.status === "SCORED" || s?.aiScore != null).length;
    const qualified = todaySignals.filter((s: any) => s?.qualified === true).length;
    const qualifiedSignalsToday = todaySignals.filter((s: any) => s?.qualified === true);
    const staleThresholdUsedMs = Number(lastSeedRun?.staleThresholdUsedMs ?? 30 * 60 * 1000);
    const seedSlaThresholdMs = 10 * 60 * 1000;
    let freshQualifiedSignals = 0;
    let staleQualifiedSignals = 0;
    const qualifiedToSeedLatencyValuesMs: number[] = [];
    const seedSlaBreachSignals: NonNullable<FunnelHealthResponse["seedSlaBreachSignals"]> = [];

    for (const s of qualifiedSignalsToday) {
      const signalId = String(s?.id || "");
      const symbol = String(s?.ticker || "UNKNOWN");
      const createdAt = typeof s?.createdAt === "string" ? s.createdAt : null;
      const createdMs = getSignalTimestampMs(s, "createdAt");
      const seedEvaluatedAt = typeof s?.seedEvaluatedAt === "string" ? s.seedEvaluatedAt : null;
      const seedEvaluatedMs = seedEvaluatedAt ? Date.parse(seedEvaluatedAt) : Number.NaN;

      const ageMs = Number.isFinite(createdMs) ? Math.max(0, Date.now() - (createdMs as number)) : null;
      if (typeof ageMs === "number" && ageMs <= staleThresholdUsedMs) freshQualifiedSignals += 1;
      else staleQualifiedSignals += 1;

      if (Number.isFinite(createdMs) && Number.isFinite(seedEvaluatedMs)) {
        qualifiedToSeedLatencyValuesMs.push(Math.max(0, (seedEvaluatedMs as number) - (createdMs as number)));
      }

      const missingSeedEvalBeyondSla =
        Number.isFinite(createdMs) &&
        !Number.isFinite(seedEvaluatedMs) &&
        Date.now() - (createdMs as number) > seedSlaThresholdMs;

      if (missingSeedEvalBeyondSla) {
        seedSlaBreachSignals.push({
          signalId,
          symbol,
          createdAt,
          seedEvaluatedAt,
          ageMs,
          staleThresholdUsedMs,
        });
      }
    }

    const qualifiedToSeedLatencyMaxMs =
      qualifiedToSeedLatencyValuesMs.length > 0 ? Math.max(...qualifiedToSeedLatencyValuesMs) : null;
    const qualifiedToSeedLatencyAvgMs =
      qualifiedToSeedLatencyValuesMs.length > 0
        ? Math.round(
            qualifiedToSeedLatencyValuesMs.reduce((sum, value) => sum + value, 0) /
              qualifiedToSeedLatencyValuesMs.length,
          )
        : null;
    const seedSlaBreached = seedSlaBreachSignals.length > 0;

    // SEEDED: from funnelStats (seedCreatedCount is bumped by seed-from-signals)
    const seeded = num(funnelData.seedCreatedCount);

    // TRADES: Filter by etDate for today
    const todayTrades = (tradesForMetrics || []).filter((t: any) => t?.etDate === dateET);
    
    // EXECUTED: trades that actually entered the market (not AUTO_PENDING)
    const executed = todayTrades.filter((t: any) =>
      (t?.source === "AUTO") &&
      (t?.status === "OPEN" || t?.status === "CLOSED" || t?.status === "HIT" || t?.status === "STOPPED")
    ).length;

    // executedAndClosedCount: broker-executed trades that have since been closed
    const executedAndClosedCount = todayTrades.filter((t: any) =>
      (t?.source === "AUTO" || t?.source === "auto-entry") &&
      (t?.status === "CLOSED" || t?.status === "HIT" || t?.status === "STOPPED") &&
      (t?.executeOutcome === "EXECUTED" || Boolean(t?.alpacaOrderId))
    ).length;

    // SEEDED_BUT_NOT_EXECUTED: trades that are genuinely active AUTO_PENDING (not archived/errored/placed).
    // With the execute route now archiving all skip cases, only legitimately unprocessed
    // pending trades will have status=AUTO_PENDING and no alpacaOrderId.
    const seededButNotExecuted = todayTrades.filter((t: any) => {
      if (t?.source !== "AUTO" && t?.source !== "auto-entry") return false;
      if (t?.status !== "AUTO_PENDING") return false;
      if (Boolean(t?.alpacaOrderId) || Boolean(t?.brokerOrderId)) return false;
      return true;
    }).length;

    // Breakdown of executeOutcome values for seeded-but-not-executed trades
    // Scoped to today's AUTO trades that were NOT broker-executed (no alpacaOrderId)
    const executeSkipReasonBreakdown: Record<string, number> = {};
    for (const t of todayTrades) {
      if (!t?.executeOutcome) continue;
      if (t.executeOutcome === "EXECUTED" || t.executeOutcome === "PENDING") continue;
      if (t?.source !== "AUTO" && t?.source !== "auto-entry") continue;
      // Do not count trades that actually reached the broker
      if (Boolean(t?.alpacaOrderId) || Boolean(t?.brokerOrderId)) continue;
      const outcome = String(t.executeOutcome);
      executeSkipReasonBreakdown[outcome] = (executeSkipReasonBreakdown[outcome] ?? 0) + 1;
    }
    const noAutoPendingSkips =
      (executeSkipReasonBreakdown["SKIPPED_NO_AUTO_PENDING"] ?? 0) +
      (executeSkipReasonBreakdown["SKIPPED_NO_LONGER_ELIGIBLE"] ?? 0);

    // Stale/expired explicit count and timing diagnostics
    const staleExpiredCount = executeSkipReasonBreakdown["SKIPPED_EXPIRED"] ?? 0;

    // Execute blocker metrics — surfaced for ops and agent monitoring
    const activeMalformedPendingCount = todayTrades.filter((t: any) => {
      if (t?.source !== "AUTO" && t?.source !== "auto-entry") return false;
      if (t?.status !== "AUTO_PENDING") return false;
      if (t?.closedAt) return false;
      if (Boolean(t?.alpacaOrderId) || Boolean(t?.brokerOrderId)) return false;
      const outcome = String(t?.executeOutcome || "").toUpperCase();
      const reason = String(t?.executeReason || "").toLowerCase();
      return (
        outcome === "MALFORMED" ||
        reason === "invalid_pending_missing_risk" ||
        reason === "invalid_trade" ||
        reason === "rescore_required" ||
        reason === "stale_trade"
      );
    }).length;

    const terminalMalformedCount = todayTrades.filter((t: any) => {
      if (t?.source !== "AUTO" && t?.source !== "auto-entry") return false;
      const status = String(t?.status || "").toUpperCase();
      if (status !== "ERROR" && status !== "ARCHIVED" && status !== "CLOSED") return false;
      const outcome = String(t?.executeOutcome || "").toUpperCase();
      const reason = String(t?.executeReason || "").toLowerCase();
      return (
        outcome === "MALFORMED" ||
        outcome === "ERROR" ||
        reason === "invalid_pending_missing_risk" ||
        reason === "invalid_trade" ||
        reason === "rescore_required" ||
        reason === "stale_trade"
      );
    }).length;

    const rescoreRequiredCount = todayTrades.filter((t: any) =>
      (t?.source === "AUTO" || t?.source === "auto-entry") &&
      !t?.closedAt &&
      (String(t?.status || "").toUpperCase() === "AUTO_PENDING") &&
      typeof t?.executeReason === "string" &&
      (t.executeReason === "rescore_required" || t.executeReason === "rescore_failed")
    ).length;
    const scoreThresholdBlockedCount = todayTrades.filter((t: any) =>
      (t?.source === "AUTO" || t?.source === "auto-entry") &&
      typeof t?.executeReason === "string" &&
      (t.executeReason === "score_threshold" || t.executeReason === "score_below_base_tier_threshold" || t.executeReason === "overlay_grade_excluded")
    ).length;
    const priceDriftSkippedCount = executeSkipReasonBreakdown["SKIPPED_PRICE_DRIFT"] ?? 0;
    const stalePendingCount = todayTrades.filter((t: any) =>
      (t?.source === "AUTO" || t?.source === "auto-entry") &&
      t?.status === "AUTO_PENDING" &&
      !t?.closedAt &&
      typeof t?.seededAt === "string" &&
      Date.now() - Date.parse(t.seededAt) > 30 * 60 * 1000
    ).length;
    const executeSlaBreached =
      marketOpen && seeded > 0 && executed === 0 && (activeMalformedPendingCount > 0 || rescoreRequiredCount > 0);

    const staleTimingStats = (() => {
      const staleTrades = todayTrades.filter((t: any) =>
        (t?.source === "AUTO" || t?.source === "auto-entry") &&
        t?.executeOutcome === "SKIPPED_EXPIRED" &&
        typeof t?.pendingAgeMs === "number"
      );
      if (staleTrades.length === 0) return null;
      const avgAgeMs = staleTrades.reduce((s: number, t: any) => s + (t.pendingAgeMs as number), 0) / staleTrades.length;
      const thresholdMs: number | null = staleTrades[0]?.staleThresholdUsedMs ?? null;
      return {
        count: staleTrades.length,
        avgAgeMs: Math.round(avgAgeMs),
        thresholdMs,
        overThresholdPct: thresholdMs
          ? Math.round((staleTrades.filter((t: any) => (t.pendingAgeMs as number) > thresholdMs).length / staleTrades.length) * 1000) / 10
          : null,
      };
    })();

    // -------------------------------------------------------------------------
    // Capacity Metrics
    // -------------------------------------------------------------------------
    const currentOpenPositions = brokerTruth.positionsCount ?? 0;
    const maxOpenPositions = guardConfig.maxOpenPositions;
    const entriesToday = guardState.entriesToday ?? 0;
    const maxEntriesPerDay = guardConfig.maxEntriesPerDay;
    const remainingPositionSlots = Math.max(0, maxOpenPositions - currentOpenPositions);
    const remainingEntriesToday = Math.max(0, maxEntriesPerDay - entriesToday);
    
    // Capacity utilization: how much of available capacity was used by seeding
    const capacityUtilization = safePercent(seeded, Math.max(1, remainingPositionSlots + seeded));

    // -------------------------------------------------------------------------
    // Conversion Rates
    // -------------------------------------------------------------------------
    const signalToQualified = safePercent(qualified, signalsReceived);
    const qualifiedToSeeded = safePercent(seeded, qualified);
    const seededToExecuted = safePercent(executed, seeded);
    const qualifiedButNotSeeded = qualifiedSignalsToday.filter((s: any) => s?.seedOutcome !== "created").length;

    const seedSkipReasonBreakdown: Record<string, number> = {};
    if (lastSeedRun?.skippedByReason) {
      for (const [reason, count] of Object.entries(lastSeedRun.skippedByReason)) {
        if (typeof count !== "number" || !Number.isFinite(count)) continue;
        seedSkipReasonBreakdown[reason] = count;
      }
    }

    // -------------------------------------------------------------------------
    // Protection Integrity Audit
    // -------------------------------------------------------------------------
    let protectionMissingTickers: string[] = [];
    let brokerIsFlat = false;
    let staleMismatchTickers: string[] = [];
    let openProtectionBlockerCount = 0;
    let protectionDetail: FunnelHealthResponse["protectionDetail"] | undefined;
    
    if (!brokerTruth.error) {
      const brokerPositionsCount = brokerTruth.positionsCount ?? (brokerTruth.positions || []).length;
      const brokerOrdersCount = brokerTruth.openOrdersCount ?? (brokerTruth.openOrders || []).length;
      brokerIsFlat = brokerPositionsCount === 0 && brokerOrdersCount === 0;

      // Deduplicate: when multiple OPEN records exist for the same broker position,
      // audit only the canonical (richest-metadata) trade so ghost duplicates lacking
      // stopOrderId do not trigger false PROTECTION_MISSING incidents.
      const { canonical: canonicalMap, diagnostics: dupDiag } = selectCanonicalOpenTrades(tradesForMetrics || []);

      if (dupDiag.length > 0) {
        console.warn("[funnel-health] duplicate OPEN trades detected — protection audit using canonical only", {
          duplicateGroups: dupDiag.map((d) => ({
            ticker: d.ticker,
            canonical: d.canonicalId,
            source: d.canonicalSource,
            richness: d.canonicalRichness,
            ghostCount: d.ghostCount,
            ghostIds: d.ghostIds,
          })),
        });
      }

      const openTrades = Array.from(canonicalMap.values())
        .filter((t: any) => isOpenTradeStatus(t?.status))
        .map((t: any) => ({
          id: String(t.id || ""),
          ticker: String((t?.symbol ?? t.ticker) || ""),
          side: String(t.side || ""),
          status: String(t.status || ""),
          stopOrderId: t.stopOrderId || t.alpacaStopOrderId,
        }));

      if (openTrades.length > 0) {
        const audit = auditProtectionIntegrity({
          openTrades,
          brokerPositions: brokerTruth.positions || [],
          brokerOrders: brokerTruth.openOrders || [],
          marketOpen,
        });

        // Distinguish stale mismatch (broker flat) from live protection issues
        // BROKER_DB_MISMATCH = trade in DB but no broker position (reconciliation issue, NOT stop protection)
        // Only MISSING_STOP represents a live stop-protection emergency
        const missingProtectionIncidents = audit.incidents.filter(
          (i) => i.code === "MISSING_STOP"
        );

        if (brokerIsFlat) {
          // Broker is flat — these are stale DB records, not live risk
          staleMismatchTickers = [...new Set(missingProtectionIncidents.map((i) => i.symbol))];
          // Don't report as protection_missing — this is a reconciliation issue
        } else {
          // Broker has positions — these are real protection issues
          protectionMissingTickers = [...new Set(missingProtectionIncidents.map((i) => i.symbol))];
        }

        // ── Per-trade flatten lifecycle diagnostics ─────────────────────
        // Evaluate each open trade with evaluateTradeProtectionNow to get the
        // full protection + flatten lifecycle state for operator/agent visibility.
        const perTradeDetail = Array.from(canonicalMap.values())
          .filter((t: any) => isOpenTradeStatus(t?.status))
          .map((trade: any) => {
            const protNow = evaluateTradeProtectionNow(
              trade,
              brokerTruth.positions || [],
              brokerTruth.openOrders || [],
            );
            const inFlattenMode =
              protNow.flattenLifecycleState === "FLATTEN_IN_PROGRESS" ||
              protNow.flattenLifecycleState === "FLATTEN_PARTIALLY_FILLED";
            const nextAction = !protNow.brokerPositionExists
              ? "no_broker_position_reconcile_db"
              : protNow.isCurrentlyProtected
                ? "none_position_protected"
                : inFlattenMode
                  ? "monitoring_close_order"
                  : protNow.shouldFlatten
                    ? "trigger_emergency_flatten"
                    : "trigger_stop_repair";
            return {
              tradeId: protNow.tradeId,
              symbol: protNow.symbol,
              isCurrentlyProtected: protNow.isCurrentlyProtected,
              brokerPositionExists: protNow.brokerPositionExists,
              brokerStopDetected: protNow.brokerStopDetected,
              activeCloseOrderDetected: protNow.activeCloseOrderDetected,
              activeCloseOrderId: protNow.activeCloseOrderId,
              activeCloseOrderStatus: protNow.activeCloseOrderStatus,
              brokerPositionQty: protNow.brokerPositionQty,
              residualQty: protNow.brokerPositionQty,
              flattenLifecycleState: protNow.flattenLifecycleState,
              recoveryState: protNow.historicalProtectionStatus ?? "none",
              nextAction,
            };
          });

        if (!brokerIsFlat) {
          openProtectionBlockerCount = perTradeDetail.filter(
            (d) => !d.isCurrentlyProtected || !d.brokerPositionExists,
          ).length;
        }

        // Only include protectionDetail when there are unprotected trades or flatten-in-progress
        const hasIssues = perTradeDetail.some(
          (d) => !d.isCurrentlyProtected && d.brokerPositionExists,
        );
        if (hasIssues) {
          protectionDetail = {
            tickers: protectionMissingTickers,
            perTrade: perTradeDetail,
          };
        }
      }
    }

    // -------------------------------------------------------------------------
    // Timestamp metrics (best-effort from funnel data)
    // -------------------------------------------------------------------------
    const lastScanAt = funnelData.lastScanAt;
    const lastSeedAt = lastSeedRun?.runAt ?? lastScanAt;
    const lastEntryAt = guardState.lastEntryAt;
    const lastExecuteRunAt = guardState.lastExecuteRunAt;
    
    // lastEntryAt: bumped when trades execute (entry activity)
    // lastExecuteRunAt: bumped on every execute run, even if no trades to execute (execute cron activity)
    const minsSinceLastExecute = minutesSince(lastExecuteRunAt);
    const minsSinceLastSeed = minutesSince(lastSeedAt);

    // -------------------------------------------------------------------------
    // Incident Detection
    // -------------------------------------------------------------------------
    // Count fresh AUTO_PENDING trades with no terminal outcome — these are the ones
    // that genuinely need execution (not historical skipped/closed/archived records).
    const freshUnresolvedPendingCount = todayTrades.filter((t: any) =>
      (t?.source === "AUTO" || t?.source === "auto-entry") &&
      t?.status === "AUTO_PENDING" &&
      !Boolean(t?.alpacaOrderId) &&
      !Boolean(t?.brokerOrderId) &&
      (!t?.executeOutcome || t.executeOutcome === "PENDING")
    ).length;

    // AUTO_PENDING trades older than the stale threshold that should have been archived
    const staleMaxAgeMs = Number.isFinite(Number(process.env.AUTO_ENTRY_MAX_PENDING_AGE_MS))
      ? Math.max(10_000, Number(process.env.AUTO_ENTRY_MAX_PENDING_AGE_MS))
      : 180_000;
    const staleActivePendingCount = todayTrades.filter((t: any) =>
      (t?.source === "AUTO" || t?.source === "auto-entry") &&
      t?.status === "AUTO_PENDING" &&
      !Boolean(t?.alpacaOrderId) &&
      typeof t?.createdAt === "string" &&
      Date.now() - Date.parse(t.createdAt) > staleMaxAgeMs
    ).length;

    const cTierQualityBlockCount =
      (seedSkipReasonBreakdown["c_tier_quality_block"] ?? 0) +
      (seedSkipReasonBreakdown["flat_trend_block"] ?? 0) +
      (seedSkipReasonBreakdown["weak_volume_block"] ?? 0) +
      (seedSkipReasonBreakdown["vwap_alignment_block"] ?? 0) +
      (seedSkipReasonBreakdown["poor_rr_block"] ?? 0);
    const qualityThresholdBlockCount = seedSkipReasonBreakdown["below_threshold"] ?? 0;

    const incidents = detectIncidents({
      marketOpen,
      candidates,
      qualified,
      freshQualifiedSignals,
      staleQualifiedSignals,
      seeded,
      executed,
      remainingPositionSlots,
      minsSinceLastExecute,
      seedSlaBreached,
      noAutoPendingSkips,
      protectionMissingTickers,
      activeMalformedPendingCount,
      openProtectionBlockerCount,
      freshUnresolvedPendingCount,
      staleActivePendingCount,
      cTierQualityBlockCount,
      qualityThresholdBlockCount,
    });

    // Add lower-severity incident for stale broker/DB mismatch (not live risk)
    if (staleMismatchTickers.length > 0) {
      incidents.push({
        code: "STALE_BROKER_DB_MISMATCH",
        severity: "LOW",
        message: `${staleMismatchTickers.length} trade(s) in DB but broker is flat — needs reconciliation (not live risk): ${staleMismatchTickers.join(", ")}`,
        context: { tickers: staleMismatchTickers, brokerIsFlat: true, count: staleMismatchTickers.length },
      });
    }

    // Count incident severities for scoring
    const criticalIncidents = incidents.filter((i) => i.severity === "CRITICAL").length;
    const highIncidents = incidents.filter((i) => i.severity === "HIGH").length;

    // -------------------------------------------------------------------------
    // Funnel Score
    // -------------------------------------------------------------------------
    const score = computeFunnelScore({
      signalToQualified,
      qualifiedToSeeded,
      seededToExecuted,
      capacityUtilization,
      incidentCount: incidents.length,
      criticalIncidents,
      highIncidents,
    });

    // -------------------------------------------------------------------------
    // Lightweight log
    // -------------------------------------------------------------------------
    console.log("[funnel-health] snapshot", {
      candidates,
      signalsReceived,
      scored,
      qualified,
      seeded,
      executed,
      openPositions: currentOpenPositions,
      entriesToday,
      incidentCount: incidents.length,
      score: score.value,
      marketOpen,
    });

    const response: FunnelHealthResponse = {
      ok: true,
      dateET,
      marketOpen,
      funnel: {
        candidates,
        signalsReceived,
        scored,
        qualified,
        seeded,
        executed,
        seededButNotExecuted,
      },
      capacity: {
        currentOpenPositions,
        maxOpenPositions,
        entriesToday,
        maxEntriesPerDay,
        remainingPositionSlots,
        remainingEntriesToday,
        utilization: capacityUtilization,
      },
      conversion: {
        signalToQualified,
        qualifiedToSeeded,
        seededToExecuted,
      },
      qualifiedButNotSeeded,
      freshQualifiedSignals,
      staleQualifiedSignals,
      qualifiedToSeedLatencyMaxMs,
      qualifiedToSeedLatencyAvgMs,
      seedSlaBreached,
      seedSlaBreachSignals: seedSlaBreachSignals.slice(0, 50),
      ...(Object.keys(seedSkipReasonBreakdown).length > 0 ? { seedSkipReasonBreakdown } : {}),
      lastSeedRunAt: lastSeedRun?.runAt ?? null,
      lastSeedRunSource: lastSeedRun?.source ?? null,
      lastSeedRunId: lastSeedRun?.runId ?? null,
      score,
      incidents,
      timestamps: {
        lastSeedAt,
        lastExecuteAt: lastEntryAt,
        minsSinceLastSeed,
        minsSinceLastExecute,
      },
      // Additional diagnostic counts
      ...(executedAndClosedCount > 0 ? { executedAndClosedCount } : {}),
      ...(freshUnresolvedPendingCount > 0 ? { currentOpenPendingCount: freshUnresolvedPendingCount } : {}),
      // ─── Market-open funnel flow diagnostics ────────────────────────
      // Explains exactly where the funnel pipeline is stopping during market hours
      ...(marketOpen ? {
        funnelFlowDiagnostics: (() => {
          const scansRun = num(funnelData.scansRun);
          const scansSkipped = num(funnelData.scansSkipped);
          const lastScanStatus = funnelData.lastScanStatus;
          const signalsPosted = num(funnelData.signalsPosted);
          const drainScored = num(funnelData.drainScored);

          // Determine the bottleneck stage
          type FlowStage = "scan" | "signal_post" | "scoring" | "qualification" | "seeding" | "execution" | "flowing";
          let stoppedAt: FlowStage = "flowing";
          let stoppedReason = "funnel is flowing normally";

          if (scansRun === 0 && scansSkipped === 0) {
            stoppedAt = "scan";
            stoppedReason = "no scans have run today — cron/scheduler may not be triggering scans";
          } else if (scansRun === 0 && scansSkipped > 0) {
            stoppedAt = "scan";
            stoppedReason = `${scansSkipped} scan(s) skipped, 0 completed — last skip status: ${lastScanStatus || "unknown"}. Scanner is running but skipping (check market clock, mode config)`;
          } else if (scansRun > 0 && signalsPosted === 0) {
            stoppedAt = "signal_post";
            stoppedReason = `${scansRun} scan(s) ran but 0 signals posted — candidates may be rejected by pre-post gating or quality filters`;
          } else if (signalsPosted > 0 && signalsReceived === 0) {
            stoppedAt = "signal_post";
            stoppedReason = `${signalsPosted} signals posted but 0 received in today's window — possible timestamp/ET-day mismatch`;
          } else if (signalsReceived > 0 && scored === 0) {
            stoppedAt = "scoring";
            stoppedReason = `${signalsReceived} signals received but 0 scored — drain/scoring pipeline may not have run (drainScored=${drainScored})`;
          } else if (scored > 0 && qualified === 0) {
            stoppedAt = "qualification";
            stoppedReason = `${scored} scored but 0 qualified — all scores may be below qualification threshold`;
          } else if (qualified > 0 && seeded === 0) {
            stoppedAt = "seeding";
            stoppedReason = `${qualified} qualified but 0 seeded — seed-from-signals may not have run, or capacity/guardrails blocking`;
          } else if (seeded > 0 && executed === 0) {
            stoppedAt = "execution";
            stoppedReason = `${seeded} seeded but 0 executed — execute route may not have fired, or bracket/liquidity checks failing`;
          }

          return {
            stoppedAt,
            stoppedReason,
            stages: {
              scansRun,
              scansSkipped,
              lastScanStatus: lastScanStatus || null,
              lastScanMode: funnelData.lastScanMode || null,
              signalsPosted,
              signalsReceived,
              drainScored,
              scored,
              qualified,
              seeded,
              executed,
            },
            scanSkipsByMode: funnelData.scanSkipsByMode ?? {},
            scanRunsByMode: funnelData.scanRunsByMode ?? {},
          };
        })(),
      } : {}),
      // Broker/DB reconciliation status
      ...(brokerIsFlat && staleMismatchTickers.length > 0 ? {
        brokerReconciliation: {
          brokerIsFlat: true,
          staleMismatchTickers,
          message: "Broker is flat but DB has open trades — needs reconciliation via /api/trades/protection-audit",
        },
      } : {}),
      // Per-trade flatten lifecycle diagnostics (only present when there are issues)
      ...(protectionDetail ? { protectionDetail } : {}),
      // Skip reason breakdown for seeded-but-not-executed trades (only present when relevant)
      ...(Object.keys(executeSkipReasonBreakdown).length > 0 ? { executeSkipReasonBreakdown } : {}),
      // Archive attribution counts — derived from executeSkipReasonBreakdown
      ...(priceDriftSkippedCount > 0 ? { executeArchivedDrifted: priceDriftSkippedCount } : {}),
      ...(staleExpiredCount > 0 ? { executeArchivedStale: staleExpiredCount } : {}),
      ...((executeSkipReasonBreakdown["SKIPPED_NO_LONGER_ELIGIBLE"] ?? 0) > 0
        ? { executeArchivedNoLongerEligible: executeSkipReasonBreakdown["SKIPPED_NO_LONGER_ELIGIBLE"] }
        : {}),
      // Execute blocker metrics — always numeric for smoke-test stability
      activeMalformedPendingCount,
      terminalMalformedCount,
      staleTerminalRepairedCount,
      executeBlockerMetrics: {
        activeMalformedPendingCount,
        terminalMalformedCount,
        staleTerminalRepairedCount,
        rescoreRequiredCount,
        scoreThresholdBlockedCount,
        priceDriftSkippedCount,
        stalePendingCount,
        executeSlaBreached,
      },
      // Stale/expired diagnostics
      ...(staleExpiredCount > 0 ? { staleExpiredCount } : {}),
      ...(staleTimingStats ? { staleTimingStats } : {}),
      // ─── Final entry gate diagnostics ──────────────────────────────────
      // Computed from existing per-trade counters; no extra queries needed.
      ...(() => {
        const isDriftBlocking = priceDriftSkippedCount > 0;
        const isStaleSignalBlocking =
          freshQualifiedSignals === 0 && staleQualifiedSignals > 0 && seeded === 0;
        const isOverlayBlocking = scoreThresholdBlockedCount > 0;
        const isNoPendingBlocking =
          seeded > 0 && executed === 0 && freshUnresolvedPendingCount === 0;
        const finalEntryGateBlocked =
          marketOpen &&
          (isDriftBlocking || isStaleSignalBlocking || isOverlayBlocking || isNoPendingBlocking);
        const topFinalGateReason: "price_drift" | "overlay_block" | "stale_qualified_signal" | "no_pending" | null =
          !finalEntryGateBlocked
            ? null
            : isDriftBlocking
            ? "price_drift"
            : isStaleSignalBlocking
            ? "stale_qualified_signal"
            : isOverlayBlocking
            ? "overlay_block"
            : "no_pending";
        const finalGateActionableMessage: string | null = !finalEntryGateBlocked
          ? null
          : topFinalGateReason === "price_drift"
          ? `${priceDriftSkippedCount} trade(s) archived for price drift — run seed-from-signals to create a fresh AUTO_PENDING.`
          : topFinalGateReason === "stale_qualified_signal"
          ? `${staleQualifiedSignals} qualified signal(s) are stale (>=${Math.round(staleThresholdUsedMs / 60_000)}min) and no fresh signals exist — trigger a scan + score drain to refresh, or rely on stale-signal recovery seed.`
          : topFinalGateReason === "overlay_block"
          ? `${scoreThresholdBlockedCount} trade(s) blocked by overlay/score thresholds — review overlay config or await score improvement.`
          : `${seededButNotExecuted} AUTO_PENDING trade(s) seeded but no broker execution — check execute cron and broker connectivity.`;
        return { finalEntryGateBlocked, topFinalGateReason, finalGateActionableMessage };
      })(),
      // DEBUG: Temporary fields to verify source attribution
      _debug: {
        scope: dateET,
        etDayBounds: {
          startMs: dayStartMs,
          endMs: dayEndMs,
          startIso: new Date(dayStartMs).toISOString(),
          endIso: new Date(dayEndMs).toISOString(),
        },
        sources: {
          candidates: "funnelRedis.candidatesFound",
          signalsReceived: `signals filtered by createdAt ET-today (${dateET})`,
          scored: `signals with status=SCORED or aiScore!=null, createdAt ET-today`,
          qualified: `signals with qualified=true, createdAt ET-today`,
          seeded: "funnelRedis.seedCreatedCount",
          executed: `trades with etDate=${dateET}, source=AUTO, status in [OPEN,CLOSED,HIT,STOPPED]`,
        },
        rawCounts: {
          totalSignals: (allSignals || []).length,
          todaySignals: todaySignals.length,
          totalTrades: (tradesForMetrics || []).length,
          todayTrades: todayTrades.length,
          funnelCandidatesFound: num(funnelData.candidatesFound),
          funnelSeedCreatedCount: num(funnelData.seedCreatedCount),
          funnelSeedFromQualifiedLong: num(funnelData.seedFromQualifiedLong),
          funnelSeedFromQualifiedShort: num(funnelData.seedFromQualifiedShort),
          funnelExecuteFromSeededLong: num(funnelData.executeFromSeededLong),
          funnelExecuteFromSeededShort: num(funnelData.executeFromSeededShort),
        },
        // Sample of recent signals for debugging timestamp parsing
        sampleSignals: (allSignals || []).slice(0, 5).map((s: any) => ({
          id: s?.id?.slice?.(0, 8) ?? "?",
          symbol: s?.symbol ?? s?.ticker ?? "?",
          createdAt: s?.createdAt,
          createdAtType: typeof s?.createdAt,
          createdAtMs: typeof s?.createdAt === "number" ? s?.createdAt : 
                       typeof s?.createdAt === "string" ? Date.parse(s?.createdAt) : null,
          status: s?.status,
          qualified: s?.qualified,
          inTodayWindow: isSignalToday(s),
        })),
      },
    };

    return NextResponse.json(response, { status: 200 });
  } catch (err) {
    console.error("[funnel-health] error", err);
    return NextResponse.json(
      {
        ok: false,
        dateET,
        marketOpen: false,
        error: String(err),
        funnel: { candidates: 0, signalsReceived: 0, scored: 0, qualified: 0, seeded: 0, executed: 0, seededButNotExecuted: 0 },
        capacity: {
          currentOpenPositions: 0,
          maxOpenPositions: 3,
          entriesToday: 0,
          maxEntriesPerDay: 5,
          remainingPositionSlots: 3,
          remainingEntriesToday: 5,
          utilization: null,
        },
        conversion: { signalToQualified: null, qualifiedToSeeded: null, seededToExecuted: null },
        score: { value: 0, grade: "F", reason: "error loading data" },
        incidents: [],
      } satisfies FunnelHealthResponse,
      { status: 200 } // Return 200 even on error for graceful degradation
    );
  }
}
