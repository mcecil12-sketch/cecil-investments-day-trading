import { NextResponse } from "next/server";
import { alpacaRequest } from "@/lib/alpaca";
import { getAutoConfig } from "@/lib/autoEntry/config";
import { getAutoManageConfig } from "@/lib/autoManage/config";
import { readAutoManageTelemetry } from "@/lib/autoManage/telemetry";
import { fetchBrokerTruth } from "@/lib/broker/truth";
import { fetchAlpacaClock } from "@/lib/alpacaClock";
import { getGuardrailConfig } from "@/lib/autoEntry/guardrails";
import { readAutoEntryTelemetry } from "@/lib/autoEntry/telemetry";
import { readSignals } from "@/lib/jsonDb";
import { readTrades } from "@/lib/tradesStore";
import * as guardrailsStore from "@/lib/autoEntry/guardrailsStore";
import { readReconcileTelemetry } from "@/lib/maintenance/reconcileTelemetry";
import { computeScoringWindows } from "@/lib/ops/scoringWindows";
import { readTodayFunnel } from "@/lib/funnelRedis";
import { getEtDateString } from "@/lib/time/etDate";
import { countOperationalOpenAutoTickers, countOperationalOpenTickers } from "@/lib/trades/operational";

export const dynamic = "force-dynamic";

async function getClockSafe() {
  const r = await alpacaRequest({ method: "GET", path: "/v2/clock" });
  if (!r.ok) return null;
  try {
    return JSON.parse(r.text || "null");
  } catch {
    return null;
  }
}

function isTimestampOnEtDate(value: unknown, etDate: string): boolean {
  if (typeof value !== "string" || !value) return false;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return false;
  const stampEt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ts));
  return stampEt === etDate;
}

function isTimestampWithinHours(value: unknown, hours: number): boolean {
  if (typeof value !== "string" || !value) return false;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) return false;
  const cutoff = Date.now() - Math.max(1, hours) * 60 * 60 * 1000;
  return ts >= cutoff;
}

function latestIso(a?: string | null, b?: string | null): string | null {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  const va = Number.isFinite(ta) ? ta : null;
  const vb = Number.isFinite(tb) ? tb : null;
  if (va == null && vb == null) return null;
  if (va == null) return b || null;
  if (vb == null) return a || null;
  return va >= vb ? (a || null) : (b || null);
}

export async function GET() {
  const startedAt = new Date();

  try {
    // Fetch all data in parallel
    const [      brokerTruth,
      alpacaClock,
      guardConfig,
      etDate,
      signals,
      trades,
      clock,
      autoEntry,
      autoManage,
      reconcileTel,
      funnelToday,
    ] = await Promise.all([
      fetchBrokerTruth(),
      fetchAlpacaClock().catch(() => ({ is_open: null, next_open: null, next_close: null })),
      getGuardrailConfig(),
      Promise.resolve(getEtDateString()),
      readSignals(),
      readTrades(),
      getClockSafe(),
      Promise.resolve(getAutoConfig()),
      Promise.resolve(getAutoManageConfig()),
      readReconcileTelemetry(5),
      readTodayFunnel(),
    ]);

    // Get guard state for additional info
    const guardState = await guardrailsStore.getGuardrailsState(etDate);

    const { createdLast6Hours, scoredLast6Hours } = computeScoringWindows(signals);

    // Get last auto-entry telemetry
    const telemetry = await readAutoEntryTelemetry(etDate, 1);
    const lastAutoEntryRun = telemetry.runs?.[0] || null;

    // Get auto-manage telemetry
    const amTel = await readAutoManageTelemetry(5);
    const amLastRun = Array.isArray(amTel?.runs) && amTel.runs.length > 0 ? amTel.runs[0] : null;
    const amSummary = (amTel?.summary || {}) as Record<string, unknown>;

    // Compute: would skip due to max_open_positions?
    const wouldSkipMaxOpenPositions = brokerTruth.error
      ? null
      : brokerTruth.positionsCount >= guardConfig.maxOpenPositions;

    // --- Broker truth openTrades (positions are the only "open positions" that matter for max-open gating) ---
    const brokerPositionsCount =
      typeof brokerTruth.positionsCount === "number"
        ? brokerTruth.positionsCount
        : Array.isArray(brokerTruth.positions)
          ? brokerTruth.positions.length
          : 0;

    const brokerOpenOrdersCount =
      typeof brokerTruth.openOrdersCount === "number"
        ? brokerTruth.openOrdersCount
        : Array.isArray(brokerTruth.openOrders)
          ? brokerTruth.openOrders.length
          : 0;

    // IMPORTANT: entryState.openTrades is now broker-truth based.
    // This prevents "ghost open trades" from ever showing up in ops/status.
    const brokerTruthOpenTrades = brokerPositionsCount;

    // If you need "fromAutoEntry", we use brokerPositionsCount as a safe proxy
    // (assume all open positions count against the gate).
    const brokerTruthFromAutoEntry = brokerPositionsCount;

    // Diagnostics: All operational counts use authoritative broker-truth filter
    const dbOpenTradesCount = brokerTruthOpenTrades;
    const dbActualOperationalCount = brokerTruthOpenTrades;
    const dbAutoOpenTradesCount = countOperationalOpenAutoTickers(trades);
    
    // Mismatch detection: compare broker positions count vs actual operational count
    const openTradesMismatch = brokerPositionsCount !== dbActualOperationalCount;

    // Legacy flags for backward compatibility
    const pause = process.env.PAUSE_AUTOTRADING === "1";
    const marketClosed = clock && typeof clock.is_open === "boolean" ? !clock.is_open : null;
    const reasons: string[] = [];
    if (pause) reasons.push("paused");
    if (marketClosed === true) reasons.push("market_closed");
    if (!autoEntry.enabled) reasons.push("auto_entry_disabled");
    if (!autoManage.enabled) reasons.push("auto_manage_disabled");

    const skips = {
      insufficientBars: funnelToday.skipInsufficientBars ?? 0,
      stale: funnelToday.skipStale ?? 0,
      volumeTooLow: funnelToday.skipVolumeTooLow ?? 0,
      dollarVolumeTooLow: funnelToday.skipDollarVolume ?? 0,
      priceTooLow: funnelToday.skipPriceTooLow ?? 0,
      spreadTooWide: funnelToday.skipSpreadTooWide ?? 0,
    };

    const readiness = {
      entryReadiness:
        !brokerTruth.error &&
        !wouldSkipMaxOpenPositions &&
        !guardState.autoDisabledReason &&
        (alpacaClock?.is_open ?? true),
      brokerConnected: !brokerTruth.error,
      scoringHealthy: createdLast6Hours.pending + createdLast6Hours.error < 50,
      marketOpen: alpacaClock?.is_open ?? null,
    };

    const lastScoredAtAny = signals
      .map((s: any) => (typeof s?.scoredAt === "string" ? s.scoredAt : null))
      .filter(Boolean)
      .sort((a: string, b: string) => Date.parse(b) - Date.parse(a))[0] || null;
    const lastSuccessfulScanAt = latestIso(funnelToday.lastScanAt, funnelToday.updatedAt);
    const lastScoredAt = latestIso(scoredLast6Hours.lastScoredAt, lastScoredAtAny);

    const summarizeWindow = (hours: number) => {
      const windowSignals = signals.filter((s: any) => isTimestampWithinHours(s?.createdAt, hours));
      return {
        pending: windowSignals.filter((s: any) => s.status === "PENDING").length,
        scored: windowSignals.filter((s: any) => s.status === "SCORED").length,
        archivedSkip: windowSignals.filter((s: any) => s.status === "ARCHIVED" && s?.skipReason).length,
        error: windowSignals.filter((s: any) => s.status === "ERROR").length,
      };
    };

    const scoringWindow24h = summarizeWindow(24);
    const scoringWindow48h = summarizeWindow(48);

    const response = {
      ok: true,
      now: startedAt.toISOString(),
      generatedAt: startedAt.toISOString(),
      durationMs: new Date().getTime() - startedAt.getTime(),

      // Legacy fields for backward compatibility
      market: clock,
      flags: {
        pause,
        autoEntryEnabled: autoEntry.enabled,
        autoEntryPaperOnly: autoEntry.paperOnly,
        autoEntryMaxOpen: autoEntry.maxOpen,
        autoEntryMaxPerDay: autoEntry.maxPerDay,
        autoManageEnabled: autoManage.enabled,
        autoManageEodFlatten: autoManage.eodFlatten,
        autoManageTrailEnabled: autoManage.trailEnabled,
        autoManageTrailStartR: autoManage.trailStartR,
        autoManageTrailPct: autoManage.trailPct,
      },
      reasons,
      autoManageTelemetry: amTel,
      autoManageReliability: {
        flatten: {
          attempted: Number(amSummary?.eodFlattenAttempted ?? 0),
          succeeded: Number(amSummary?.eodFlattenSucceeded ?? 0),
          failed: Number(amSummary?.eodFlattenFailed ?? 0),
          lastAt: String(amSummary?.lastFlattenAt || "") || null,
          lastOutcome: String(amSummary?.lastFlattenOutcome || "") || null,
          lastFailures: Number(amSummary?.lastFlattenFailures ?? 0),
        },
        stale: {
          positionsDetected: Number(amSummary?.staleOpenPositionsCount ?? 0),
          tradesDetected: Number(amSummary?.staleOpenTradesCount ?? 0),
          lastPositionsDetected: Number(amSummary?.lastStaleOpenPositionsCount ?? 0),
          lastTradesDetected: Number(amSummary?.lastStaleOpenTradesCount ?? 0),
        },
        replacement: {
          lastConsidered: Number(amSummary?.lastReplacementConsidered ?? 0) > 0,
          lastExecuted: Number(amSummary?.lastReplacementExecuted ?? 0) > 0,
          lastReason: String(amSummary?.lastReplacementReason || "") || null,
          consideredInRecentRuns: (Array.isArray(amTel?.runs) ? amTel.runs : []).filter((r: any) => r?.replacementConsidered).length,
          executedInRecentRuns: (Array.isArray(amTel?.runs) ? amTel.runs : []).filter((r: any) => r?.replacementExecuted).length,
        },
        lastRun: amLastRun
          ? {
              at: amLastRun.ts || null,
              outcome: amLastRun.outcome || null,
              reason: amLastRun.reason || null,
              replacementConsidered: Boolean(amLastRun.replacementConsidered),
              replacementExecuted: Boolean(amLastRun.replacementExecuted),
              replacementReason: amLastRun.replacementReason || null,
            }
          : null,
      },
      reconcileTelemetry: reconcileTel,

      // New comprehensive diagnostics
      broker: {
        fetchedAt: brokerTruth.fetchedAt,
        positionsCount: brokerTruth.positionsCount,
        openOrdersCount: brokerTruth.openOrdersCount,
        error: brokerTruth.error || null,
        positions: brokerTruth.positions,
        openOrders: brokerTruth.openOrders,
      },

      // Entry gating configuration
      entryGating: {
        enabled: guardConfig.enabled,
        maxOpenPositions: guardConfig.maxOpenPositions,
        maxEntriesPerDay: guardConfig.maxEntriesPerDay,
        cooldownAfterLossMin: guardConfig.cooldownAfterLossMin,
        tickerCooldownMin: guardConfig.tickerCooldownMin,
        maxConsecutiveFailures: guardConfig.maxConsecutiveFailures,
      },

      // Entry state
      entryState: {
        wouldSkipMaxOpenPositions,
        reason: wouldSkipMaxOpenPositions
          ? `brokerPositionsCount=${brokerTruth.positionsCount} >= maxOpenPositions=${guardConfig.maxOpenPositions}`
          : brokerTruth.error
            ? `broker_truth_error: ${brokerTruth.error}`
            : "READY",
        guardState: {
          entriesToday: guardState.entriesToday,
          consecutiveFailures: guardState.consecutiveFailures,
          lastLossAt: guardState.lastLossAt,
          autoDisabledReason: guardState.autoDisabledReason,
          lastFailureAt: guardState.lastFailureAt,
          lastFailureReason: guardState.lastFailureReason,
          lastFailureRunId: guardState.lastFailureRunId,
          lastFailureTradeId: guardState.lastFailureTradeId,
        },
        // BROKER-TRUTH based openTrades (not DB, to eliminate ghost trade reporting)
        openTrades: {
          total: brokerTruthOpenTrades,
          fromAutoEntry: brokerTruthFromAutoEntry,
          // Include broker truth details for clarity
          brokerPositionsCount,
          brokerOpenOrdersCount,
        },
        // Diagnostics: DB state for mismatch detection without blocking automation
        diagnostics: {
          dbOpenTradesCount,
          dbAutoOpenTradesCount,
          dbActualOperationalCount,
          openTradesMismatch,
          mismatchNote: openTradesMismatch
            ? `DB operational count=${dbActualOperationalCount} but broker positions=${brokerPositionsCount}. Run reconcile-open-trades to cleanup stale conflicts.`
            : null,
        },
      },

      autoEntry: {
        consecutiveFailures: guardState.consecutiveFailures,
        maxConsecutiveFailures: guardConfig.maxConsecutiveFailures,
        autoDisabledReason: guardState.autoDisabledReason,
        lastFailureAt: guardState.lastFailureAt,
        lastFailureReason: guardState.lastFailureReason,
        lastFailureRunId: guardState.lastFailureRunId,
        lastFailureTradeId: guardState.lastFailureTradeId,
      },

      // Scoring backlog
      scoring: {
        lastSuccessfulScanAt,
        lastScoredAt,
        createdLast6Hours: {
          total: createdLast6Hours.total,
          pending: createdLast6Hours.pending,
          scored: createdLast6Hours.scored,
          error: createdLast6Hours.error,
          archived: createdLast6Hours.archived,
        },
        scoredLast6Hours: {
          total: scoredLast6Hours.total,
          scored: scoredLast6Hours.scored,
          error: scoredLast6Hours.error,
          lastScoredAt: scoredLast6Hours.lastScoredAt,
        },
        allTime: {
          total: signals.length,
          pending: signals.filter((s) => s.status === "PENDING").length,
          scored: signals.filter((s) => s.status === "SCORED").length,
          error: signals.filter((s) => s.status === "ERROR").length,
          archived: signals.filter((s) => s.status === "ARCHIVED").length,
        },
        windows: {
          h24: scoringWindow24h,
          h48: scoringWindow48h,
        },
      },

      // Last auto-entry run summary
      lastAutoEntry: lastAutoEntryRun
        ? {
            at: lastAutoEntryRun.at,
            outcome: lastAutoEntryRun.outcome,
            reason: lastAutoEntryRun.reason,
            detail: lastAutoEntryRun.detail || null,
            ticker: lastAutoEntryRun.ticker || null,
            tradeId: lastAutoEntryRun.tradeId || null,
            source: lastAutoEntryRun.source || null,
            runId: lastAutoEntryRun.runId || null,
          }
        : null,

      // Health check
      health: {
        brokerConnected: readiness.brokerConnected,
        scoringHealthy: readiness.scoringHealthy, // Alert if >50 pending+error
        entryReadiness: readiness.entryReadiness,
      },
      readiness,
      skips,

      // Funnel visibility - comprehensive metrics for "why no trades happened"
      funnel: {
        date: funnelToday.date,
        updatedAt: funnelToday.updatedAt,
        
        // Scan stage
        scan: {
          runsToday: funnelToday.scansRun ?? 0,
          skippedToday: funnelToday.scansSkipped ?? 0,
          candidatesFound: funnelToday.candidatesFound ?? 0,
          signalsPosted: funnelToday.signalsPosted ?? 0,
          lastScanAt: funnelToday.lastScanAt,
          lastScanMode: funnelToday.lastScanMode,
          runsByMode: funnelToday.scanRunsByMode ?? {},
          skipsByMode: funnelToday.scanSkipsByMode ?? {},
        },
        
        // Scoring stage
        scoring: {
          signalsReceivedToday: funnelToday.signalsReceived ?? 0,
          pendingNow: signals.filter((s) => s.status === "PENDING").length,
          scoredToday: funnelToday.gptScored ?? 0,
          errorsToday: signals.filter((s) => s.status === "ERROR" && isTimestampOnEtDate(s.createdAt, funnelToday.date)).length,
          drainsRun: funnelToday.drainsRun ?? 0,
          drainScored: funnelToday.drainScored ?? 0,
          drainClaimedThisRun: funnelToday.drainClaimedThisRun ?? 0,
          drainSentToScorer: funnelToday.drainSentToScorer ?? 0,
          persistedScored: funnelToday.drainPersistedScored ?? 0,
          persistedArchived: funnelToday.drainPersistedArchived ?? 0,
          persistedError: funnelToday.drainPersistedError ?? 0,
          backlogDeltaToday:
            (funnelToday.signalsReceived ?? 0) -
            ((funnelToday.drainPersistedScored ?? 0) +
              (funnelToday.drainPersistedArchived ?? 0) +
              (funnelToday.drainPersistedError ?? 0)),
          drainPreGptSkipped: funnelToday.drainPreGptSkipped ?? 0,
          recentSkippedStale: funnelToday.skipStale ?? 0,
          recentSkippedInsufficientBars:
            (funnelToday.drainSkippedInsufficientBars ?? 0) || (funnelToday.skipInsufficientBars ?? 0),
          recentSkippedLowVolume:
            (funnelToday.drainSkippedVolumeTooLow ?? 0) || (funnelToday.skipVolumeTooLow ?? 0),
          recentSkippedDollarVolume:
            (funnelToday.drainSkippedDollarVolume ?? 0) || (funnelToday.skipDollarVolume ?? 0),
          recentSkippedPriceTooLow:
            (funnelToday.drainSkippedPriceTooLow ?? 0) || (funnelToday.skipPriceTooLow ?? 0),
          recentSkippedSpreadTooWide:
            (funnelToday.drainSkippedSpreadTooWide ?? 0) || (funnelToday.skipSpreadTooWide ?? 0),
          recentParseFailures: funnelToday.errorParseFailed ?? 0,
          recentDeadlineExceeded: funnelToday.drainTimeout ?? 0,
          drainTimeout: funnelToday.drainTimeout ?? 0,
          drainError: funnelToday.drainError ?? 0,
          modelUsage: funnelToday.gptScoredByModel ?? {},
        },
        
        // Error breakdown
        errors: {
          insufficientBars: funnelToday.errorInsufficientBars ?? 0,
          liquidityDollarVol: funnelToday.errorLiquidityDollarVol ?? 0,
          parseFailed: funnelToday.errorParseFailed ?? 0,
          rateLimited: funnelToday.errorRateLimited ?? 0,
          aiRateLimitErrors: funnelToday.aiRateLimitErrors ?? 0,
          aiTimeoutErrors: funnelToday.aiTimeoutErrors ?? 0,
          aiBreakerOpened: funnelToday.aiBreakerOpened ?? 0,
        },
        
        // Skip breakdown (not errors)
        skips,
        
        // Auto-entry stage
        autoEntry: {
          executesToday: funnelToday.autoEntryExecutes ?? 0,
          placedToday: funnelToday.autoEntryPlaced ?? 0,
          skipReasons: {
            maxOpenPositions: funnelToday.autoEntrySkipMaxOpen ?? 0,
            noPending: funnelToday.autoEntrySkipNoPending ?? 0,
            marketClosed: funnelToday.autoEntrySkipMarketClosed ?? 0,
          },
        },
        
        // Final stage
        orders: {
          placedToday: funnelToday.ordersPlaced ?? 0,
          fillsToday: funnelToday.fills ?? 0,
        },
        
        // Bottleneck diagnosis
        diagnosis: {
          bottleneck: 
            (funnelToday.candidatesFound ?? 0) === 0 ? "scan" :
            (funnelToday.signalsPosted ?? 0) === 0 ? "scan_persist" :
            signals.filter((s) => s.status === "PENDING").length > 20 ? "scoring_backlog" :
            (funnelToday.gptScored ?? 0) === 0 ? "scoring" :
            (funnelToday.autoEntryPlaced ?? 0) === 0 && wouldSkipMaxOpenPositions ? "max_open_positions" :
            (funnelToday.autoEntryPlaced ?? 0) === 0 ? "auto_entry" :
            (funnelToday.ordersPlaced ?? 0) === 0 ? "order_placement" :
            "none",
          note: 
            (funnelToday.candidatesFound ?? 0) === 0 ? "No candidates found by scanners today" :
            (funnelToday.signalsPosted ?? 0) === 0 ? "Candidates found but not persisted (check caps/dedupe)" :
            signals.filter((s) => s.status === "PENDING").length > 20
              ? `${signals.filter((s) => s.status === "PENDING").length} signals pending scoring (receivedToday=${funnelToday.signalsReceived ?? 0}, drainScored=${funnelToday.drainScored ?? 0}, sentToScorer=${funnelToday.drainSentToScorer ?? 0})`
              :
            (funnelToday.gptScored ?? 0) === 0 ? "Signals created but not scored yet" :
            (funnelToday.autoEntryPlaced ?? 0) === 0 && wouldSkipMaxOpenPositions ? `Max open positions reached (${brokerTruth.positionsCount}/${guardConfig.maxOpenPositions})` :
            (funnelToday.autoEntryPlaced ?? 0) === 0 ? "Scored signals but no auto-entry executions" :
            (funnelToday.ordersPlaced ?? 0) === 0 ? "Auto-entry ran but no orders placed" :
            "All stages operational",
        },
      },
    };

    return NextResponse.json(response, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    console.error("[ops/status] error", err);
    return NextResponse.json(
      {
        ok: false,
        error: "status_error",
        message: String(err),
        generatedAt: startedAt.toISOString(),
      },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
