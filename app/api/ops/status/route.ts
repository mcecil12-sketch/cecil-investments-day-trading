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
import { etDateString } from "@/lib/autoEntry/guardrails";
import * as guardrailsStore from "@/lib/autoEntry/guardrailsStore";

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

export async function GET() {
  const startedAt = new Date();

  try {
    // Fetch all data in parallel
    const [
      brokerTruth,
      alpacaClock,
      guardConfig,
      etDate,
      signals,
      trades,
      clock,
      autoEntry,
      autoManage,
    ] = await Promise.all([
      fetchBrokerTruth(),
      fetchAlpacaClock().catch(() => ({ is_open: null, next_open: null, next_close: null })),
      getGuardrailConfig(),
      Promise.resolve(etDateString(new Date())),
      readSignals(),
      readTrades(),
      getClockSafe(),
      Promise.resolve(getAutoConfig()),
      Promise.resolve(getAutoManageConfig()),
    ]);

    // Get guard state for additional info
    const guardState = await guardrailsStore.getGuardrailsState(etDate);

    // Compute scoring backlog
    const now = new Date();
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);
    const signalsLast6h = signals.filter(
      (s) => new Date(s.createdAt) >= sixHoursAgo && new Date(s.createdAt) <= now
    );

    const pending = signalsLast6h.filter((s) => s.status === "PENDING").length;
    const scored = signalsLast6h.filter((s) => s.status === "SCORED").length;
    const error = signalsLast6h.filter((s) => s.status === "ERROR").length;

    // Get last auto-entry telemetry
    const telemetry = await readAutoEntryTelemetry(etDate, 1);
    const lastAutoEntryRun = telemetry.runs?.[0] || null;

    // Get auto-manage telemetry
    const amTel = await readAutoManageTelemetry(5);

    // Compute: would skip due to max_open_positions?
    const wouldSkipMaxOpenPositions = brokerTruth.error
      ? null
      : brokerTruth.positionsCount >= guardConfig.maxOpenPositions;

    // Get trades counts
    const openTrades = trades.filter((t: any) => t.status === "OPEN").length;
    const autoOpenTrades = trades.filter(
      (t: any) => t.status === "OPEN" && (t.source === "auto-entry" || t.source === "AUTO")
    ).length;

    // Legacy flags for backward compatibility
    const pause = process.env.PAUSE_AUTOTRADING === "1";
    const marketClosed = clock && typeof clock.is_open === "boolean" ? !clock.is_open : null;
    const reasons: string[] = [];
    if (pause) reasons.push("paused");
    if (marketClosed === true) reasons.push("market_closed");
    if (!autoEntry.enabled) reasons.push("auto_entry_disabled");
    if (!autoManage.enabled) reasons.push("auto_manage_disabled");

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
        },
        openTrades: {
          total: openTrades,
          fromAutoEntry: autoOpenTrades,
        },
      },

      // Scoring backlog
      scoring: {
        last6Hours: {
          total: signalsLast6h.length,
          pending,
          scored,
          error,
          backlog: pending, // How many are stuck pending
        },
        allTime: {
          total: signals.length,
          pending: signals.filter((s) => s.status === "PENDING").length,
          scored: signals.filter((s) => s.status === "SCORED").length,
          error: signals.filter((s) => s.status === "ERROR").length,
          archived: signals.filter((s) => s.status === "ARCHIVED").length,
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
        brokerConnected: !brokerTruth.error,
        scoringHealthy: pending + error < 50, // Alert if >50 pending+error
        entryReadiness:
          !brokerTruth.error &&
          !wouldSkipMaxOpenPositions &&
          !guardState.autoDisabledReason &&
          (alpacaClock?.is_open ?? true),
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
