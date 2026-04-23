import { NextResponse } from "next/server";
import { fetchAlpacaClock } from "@/lib/alpacaClock";
import { fetchBrokerTruth } from "@/lib/broker/truth";
import { getGuardrailConfig } from "@/lib/autoEntry/guardrails";
import { getGuardrailsState } from "@/lib/autoEntry/guardrailsStore";
import { readTodayFunnel } from "@/lib/funnelRedis";
import { getEtDateString, getEtDayBoundsMs, isTimestampInEtDay } from "@/lib/time/etDate";
import { readTrades } from "@/lib/tradesStore";
import { readSignals } from "@/lib/jsonDb";
import { auditProtectionIntegrity } from "@/lib/risk/protection-integrity";
import { isOpenTradeStatus } from "@/lib/trades/protection";
import { getSignalTimestampMs } from "@/lib/signals/since";
import { selectCanonicalOpenTrades } from "@/lib/trades/canonicalOpenBySymbol";

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
  score: FunnelScore;
  incidents: Incident[];
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
  seeded: number;
  executed: number;
  remainingPositionSlots: number;
  minsSinceLastExecute: number | null;
  protectionMissingTickers: string[];
}): Incident[] {
  const incidents: Incident[] = [];
  const { 
    marketOpen, 
    candidates, 
    qualified, 
    seeded, 
    executed, 
    remainingPositionSlots,
    minsSinceLastExecute,
    protectionMissingTickers,
  } = params;

  // CRITICAL: Protection missing on open trades
  if (protectionMissingTickers.length > 0) {
    incidents.push({
      code: "PROTECTION_MISSING",
      severity: "CRITICAL",
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
      message: `High candidate count (${candidates}) but only ${seeded} seeded (capacity allows ${remainingPositionSlots}). Check scoring thresholds or capacity constraints.`,
      context: { candidates, seeded, remainingPositionSlots, minSeededExpected },
    });
  }

  // 2) QUALIFIED_NOT_SEEDED: qualified signals exist but none seeded
  if (qualified > 10 && seeded === 0) {
    incidents.push({
      code: "QUALIFIED_NOT_SEEDED",
      severity: "HIGH",
      message: `${qualified} qualified signals but 0 seeded. Check seeding logic or capacity constraints.`,
      context: { qualified, seeded },
    });
  }

  // 3) SEED_NOT_EXECUTED: seeded trades exist but none executed (market open)
  if (seeded > 0 && executed === 0 && marketOpen) {
    incidents.push({
      code: "SEED_NOT_EXECUTED",
      severity: "MEDIUM",
      message: `${seeded} trades seeded but 0 executed. Check execute route or broker integration.`,
      context: { seeded, executed, marketOpen },
    });
  }

  // 4) NO_EXECUTION_ACTIVITY: market open but no recent execute activity
  if (marketOpen && minsSinceLastExecute !== null && minsSinceLastExecute > 20) {
    incidents.push({
      code: "NO_EXECUTION_ACTIVITY",
      severity: "MEDIUM",
      message: `No execution activity for ${minsSinceLastExecute} minutes during market hours.`,
      context: { minsSinceLastExecute, marketOpen },
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
    const [clock, brokerTruth, guardConfig, guardState, funnelData, allTrades, allSignals] = await Promise.all([
      fetchAlpacaClock().catch(() => ({ is_open: false } as { is_open: boolean })),
      fetchBrokerTruth(),
      Promise.resolve(getGuardrailConfig()),
      getGuardrailsState(dateET),
      readTodayFunnel(),
      readTrades<any>().catch(() => []),
      readSignals().catch(() => []),
    ]);

    const marketOpen = Boolean(clock?.is_open);

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

    // SEEDED: from funnelStats (seedCreatedCount is bumped by seed-from-signals)
    const seeded = num(funnelData.seedCreatedCount);

    // TRADES: Filter by etDate for today
    const todayTrades = (allTrades || []).filter((t: any) => t?.etDate === dateET);
    
    // EXECUTED: trades that actually entered the market (not AUTO_PENDING)
    const executed = todayTrades.filter((t: any) =>
      (t?.source === "AUTO") &&
      (t?.status === "OPEN" || t?.status === "CLOSED" || t?.status === "HIT" || t?.status === "STOPPED")
    ).length;

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

    // -------------------------------------------------------------------------
    // Protection Integrity Audit
    // -------------------------------------------------------------------------
    let protectionMissingTickers: string[] = [];
    let brokerIsFlat = false;
    let staleMismatchTickers: string[] = [];
    
    if (!brokerTruth.error) {
      const brokerPositionsCount = brokerTruth.positionsCount ?? (brokerTruth.positions || []).length;
      const brokerOrdersCount = brokerTruth.openOrdersCount ?? (brokerTruth.openOrders || []).length;
      brokerIsFlat = brokerPositionsCount === 0 && brokerOrdersCount === 0;

      // Deduplicate: when multiple OPEN records exist for the same broker position,
      // audit only the canonical (richest-metadata) trade so ghost duplicates lacking
      // stopOrderId do not trigger false PROTECTION_MISSING incidents.
      const { canonical: canonicalMap, diagnostics: dupDiag } = selectCanonicalOpenTrades(allTrades || []);

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
      }
    }

    // -------------------------------------------------------------------------
    // Timestamp metrics (best-effort from funnel data)
    // -------------------------------------------------------------------------
    const lastScanAt = funnelData.lastScanAt;
    const lastEntryAt = guardState.lastEntryAt;
    
    // We don't have exact lastSeed/lastExecute timestamps, use proxies
    // lastEntryAt is bumped when trades execute, so use it for execute proxy
    const minsSinceLastExecute = minutesSince(lastEntryAt);
    const minsSinceLastSeed = minutesSince(lastScanAt); // Proxy: scan triggers seeding

    // -------------------------------------------------------------------------
    // Incident Detection
    // -------------------------------------------------------------------------
    const incidents = detectIncidents({
      marketOpen,
      candidates,
      qualified,
      seeded,
      executed,
      remainingPositionSlots,
      minsSinceLastExecute,
      protectionMissingTickers,
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
      score,
      incidents,
      timestamps: {
        lastSeedAt: lastScanAt,
        lastExecuteAt: lastEntryAt,
        minsSinceLastSeed,
        minsSinceLastExecute,
      },
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
          totalTrades: (allTrades || []).length,
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
        funnel: { candidates: 0, signalsReceived: 0, scored: 0, qualified: 0, seeded: 0, executed: 0 },
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
