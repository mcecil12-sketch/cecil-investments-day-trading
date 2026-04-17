import { NextResponse } from "next/server";
import { fetchAlpacaClock } from "@/lib/alpacaClock";
import { fetchBrokerTruth } from "@/lib/broker/truth";
import { getGuardrailConfig } from "@/lib/autoEntry/guardrails";
import { getGuardrailsState } from "@/lib/autoEntry/guardrailsStore";
import { readTodayFunnel } from "@/lib/funnelRedis";
import { getEtDateString } from "@/lib/time/etDate";
import { readTrades } from "@/lib/tradesStore";
import { readSignals } from "@/lib/jsonDb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

type Incident = {
  code: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  message: string;
  context: Record<string, unknown>;
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
  };
  conversion: {
    signalToQualified: number | null;
    qualifiedToSeeded: number | null;
    seededToExecuted: number | null;
  };
  incidents: Incident[];
  timestamps?: {
    lastSeedAt?: string | null;
    lastExecuteAt?: string | null;
    minsSinceLastSeed?: number | null;
    minsSinceLastExecute?: number | null;
  };
  error?: string;
  // DEBUG: Temporary field for attribution verification (can be removed later)
  _debug?: {
    scope: string;
    sources: Record<string, string>;
    rawCounts: Record<string, number>;
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
  minsSinceLastExecute: number | null;
}): Incident[] {
  const incidents: Incident[] = [];
  const { marketOpen, candidates, qualified, seeded, executed, minsSinceLastExecute } = params;

  // 1) UNDERUTILIZED_FUNNEL: many candidates but only 0-1 seeded
  if (candidates > 20 && seeded <= 1) {
    incidents.push({
      code: "UNDERUTILIZED_FUNNEL",
      severity: "HIGH",
      message: `High candidate count (${candidates}) but only ${seeded} seeded. Check capacity or scoring thresholds.`,
      context: { candidates, seeded },
    });
  }

  // 2) QUALIFIED_NOT_SEEDED: qualified signals exist but none seeded
  if (qualified > 5 && seeded === 0) {
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
    // -------------------------------------------------------------------------

    // Helper to check if a timestamp is from today (ET timezone)
    const isToday = (isoString?: string | null): boolean => {
      if (!isoString) return false;
      try {
        const d = new Date(isoString);
        const etFormatter = new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/New_York",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        });
        return etFormatter.format(d) === dateET;
      } catch {
        return false;
      }
    };

    // -------------------------------------------------------------------------
    // Funnel Metrics - FROM ACTUAL DATA (same-day scope)
    // -------------------------------------------------------------------------

    // SIGNALS: Filter by createdAt for today
    const todaySignals = (allSignals || []).filter((s: any) => isToday(s?.createdAt));
    const signalsReceived = todaySignals.length;
    const scored = todaySignals.filter((s: any) => s?.status === "SCORED" || s?.aiScore != null).length;
    const qualified = todaySignals.filter((s: any) => s?.qualified === true).length;

    // TRADES: Filter by etDate for today
    const todayTrades = (allTrades || []).filter((t: any) => t?.etDate === dateET);
    
    // Seeded = trades in AUTO_PENDING or beyond (created via seeding today)
    const seeded = todayTrades.filter((t: any) => 
      t?.source === "AUTO" || 
      t?.status === "AUTO_PENDING" || 
      t?.autoEntryStatus === "AUTO_PENDING" ||
      t?.status === "OPEN" ||
      t?.status === "CLOSED" ||
      t?.status === "HIT" ||
      t?.status === "STOPPED"
    ).length;

    // Executed = trades that actually entered the market (not AUTO_PENDING)
    const executed = todayTrades.filter((t: any) =>
      (t?.source === "AUTO") &&
      (t?.status === "OPEN" || t?.status === "CLOSED" || t?.status === "HIT" || t?.status === "STOPPED")
    ).length;

    // CANDIDATES: Use funnelRedis counter (scanner-attributed)
    // This is the only counter we keep from funnelRedis as it's bumped by scan runs
    const candidates = num(funnelData.candidatesFound) || num(funnelData.seedTotalCandidates) || signalsReceived;

    // -------------------------------------------------------------------------
    // Capacity Metrics
    // -------------------------------------------------------------------------
    const currentOpenPositions = brokerTruth.positionsCount ?? 0;
    const maxOpenPositions = guardConfig.maxOpenPositions;
    const entriesToday = guardState.entriesToday ?? 0;
    const maxEntriesPerDay = guardConfig.maxEntriesPerDay;
    const remainingPositionSlots = Math.max(0, maxOpenPositions - currentOpenPositions);
    const remainingEntriesToday = Math.max(0, maxEntriesPerDay - entriesToday);

    // -------------------------------------------------------------------------
    // Conversion Rates
    // -------------------------------------------------------------------------
    const signalToQualified = safePercent(qualified, signalsReceived);
    const qualifiedToSeeded = safePercent(seeded, qualified);
    const seededToExecuted = safePercent(executed, seeded);

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
      minsSinceLastExecute,
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
      },
      conversion: {
        signalToQualified,
        qualifiedToSeeded,
        seededToExecuted,
      },
      incidents,
      timestamps: {
        lastSeedAt: lastScanAt,
        lastExecuteAt: lastEntryAt,
        minsSinceLastSeed,
        minsSinceLastExecute,
      },
      // DEBUG: Temporary fields to verify source attribution
      _debug: {
        scope: dateET,
        sources: {
          candidates: "funnelRedis.candidatesFound || funnelRedis.seedTotalCandidates || signalsReceived",
          signalsReceived: `signals.json filtered by createdAt=${dateET}`,
          scored: `signals with status=SCORED or aiScore!=null, createdAt=${dateET}`,
          qualified: `signals with qualified=true, createdAt=${dateET}`,
          seeded: `trades with etDate=${dateET} and source=AUTO or status in [AUTO_PENDING, OPEN, CLOSED, HIT, STOPPED]`,
          executed: `trades with etDate=${dateET} and source=AUTO and status in [OPEN, CLOSED, HIT, STOPPED]`,
        },
        rawCounts: {
          totalSignals: (allSignals || []).length,
          todaySignals: todaySignals.length,
          totalTrades: (allTrades || []).length,
          todayTrades: todayTrades.length,
          funnelCandidatesFound: num(funnelData.candidatesFound),
          funnelSeedTotalCandidates: num(funnelData.seedTotalCandidates),
          funnelSeedFromQualifiedLong: num(funnelData.seedFromQualifiedLong),
          funnelSeedFromQualifiedShort: num(funnelData.seedFromQualifiedShort),
          funnelExecuteFromSeededLong: num(funnelData.executeFromSeededLong),
          funnelExecuteFromSeededShort: num(funnelData.executeFromSeededShort),
        },
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
        },
        conversion: { signalToQualified: null, qualifiedToSeeded: null, seededToExecuted: null },
        incidents: [],
      } satisfies FunnelHealthResponse,
      { status: 200 } // Return 200 even on error for graceful degradation
    );
  }
}
