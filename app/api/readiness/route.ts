export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getGuardrailConfig, minutesSince } from "@/lib/autoEntry/guardrails";
import * as guardrailsStore from "@/lib/autoEntry/guardrailsStore";
import { fetchBrokerTruth } from "@/lib/broker/truth";
import { getEtDateString, getEtDayBoundsMs, isTimestampInEtDay } from "@/lib/time/etDate";
import { readTrades } from "@/lib/tradesStore";
import { isOpenTradeStatus } from "@/lib/trades/protection";
import {
  auditProtectionIntegrity,
  type AuditResult,
} from "@/lib/risk/protection-integrity";
import { fetchAlpacaClockSafe } from "@/lib/alpacaClock";

import { readSignals } from "@/lib/jsonDb";
import { readTodayFunnel } from "@/lib/funnelRedis";

type Check = {
  name: string;
  ok: boolean;
  detail?: string;
};

export async function GET(req: Request) {
  const authed = await requireAuth(req);
  const publicMode = !authed.ok;

  const url = new URL(req.url);
  const base = `${url.protocol}//${url.host}`;
  const cookie = req.headers.get("cookie") || "";

  let aiHealth: any = { status: "UNKNOWN" };
  let funnel: any = { today: {} };

  // Read signals directly to avoid self-referential HTTP fetch issue
  // (internal fetch fails when called by cron/agents without cookie auth)
  let allSignals: any[] = [];
  try {
    allSignals = await readSignals();
  } catch {
    allSignals = [];
  }

  if (!publicMode) {
    const [aiHealthResp, funnelResp] = await Promise.all([
      fetch(`${base}/api/ai-health`, { headers: { cookie }, cache: "no-store" }),
      fetch(`${base}/api/funnel-stats`, { headers: { cookie }, cache: "no-store" }),
    ]);

    if (!aiHealthResp.ok) {
      return NextResponse.json(
        { ok: false, error: "upstream_ai_health_failed", status: aiHealthResp.status },
        { status: 502 }
      );
    }
    if (!funnelResp.ok) {
      return NextResponse.json(
        { ok: false, error: "upstream_funnel_failed", status: funnelResp.status },
        { status: 502 }
      );
    }

    aiHealth = await aiHealthResp.json();
    funnel = await funnelResp.json();
  } else {
    try {
      const fr = await fetch(`${base}/api/funnel-stats`, { cache: "no-store" });
      if (fr.ok) funnel = await fr.json();
    } catch {}
  }

  const todayEt = getEtDateString();
  const guardKeyUsed = guardrailsStore.getGuardrailStateKey(todayEt);
  const guardConfig = getGuardrailConfig();
  const [guardState, toggleState, brokerTruth] = await Promise.all([
    guardrailsStore.getGuardrailsState(todayEt),
    guardrailsStore.getAutoEntryEnabledState(guardConfig),
    fetchBrokerTruth(),
  ]);

  const trades = await readTrades<any>().catch(() => []);
  const openTrades = (Array.isArray(trades) ? trades : []).filter((t) => isOpenTradeStatus(t?.status));

  // Broker-truth protection audit (fail-closed on broker error)
  let protectionAudit: AuditResult | null = null;
  let protectionCritical = false;
  let brokerIsFlat = false;
  let protectionIsStaleOnly = false;
  // Positions unprotected at broker level (independent of DB trades)
  let unprotectedBrokerPositions: string[] = [];
  if (!brokerTruth.error) {
    const brokerPositions = Array.isArray(brokerTruth.positions) ? brokerTruth.positions : [];
    const brokerOrders = Array.isArray(brokerTruth.openOrders) ? brokerTruth.openOrders : [];
    brokerIsFlat = brokerPositions.length === 0 && brokerOrders.length === 0;

    // PRIMARY CHECK: iterate every live broker position and verify it has an
    // active protective stop order.  This is broker-truth-only — does NOT
    // rely on DB trades so orphaned positions are always caught.
    for (const pos of brokerPositions) {
      const sym = String(pos.symbol || "").toUpperCase();
      if (!sym) continue;
      const rawQty = Number(pos.qty ?? 0);
      const qty = Math.abs(rawQty);
      if (qty === 0) continue;

      const posSide = rawQty < 0 ? "SHORT" : "LONG";
      // A protective stop for a LONG is a sell-stop; for a SHORT it is a buy-stop
      const protectiveSide = posSide === "LONG" ? "sell" : "buy";

      const hasStop = brokerOrders.some((o: any) => {
        if (String(o.symbol || "").toUpperCase() !== sym) return false;
        const oType = String(o.type || "").toLowerCase();
        const oSide = String(o.side || "").toLowerCase();
        const oStatus = String(o.status || "").toLowerCase();
        const isStopType = oType === "stop" || oType === "stop_limit" || oType === "trailing_stop";
        const isActiveSide = oSide === protectiveSide;
        const isActive = ["new", "accepted", "pending", "held"].includes(oStatus);
        return isStopType && isActiveSide && isActive;
      });

      if (!hasStop) {
        unprotectedBrokerPositions.push(sym);
      }
    }

    if (unprotectedBrokerPositions.length > 0) {
      // Live broker positions are unprotected — this is always critical
      protectionCritical = true;
      protectionIsStaleOnly = false;
    } else if (!brokerIsFlat) {
      // All broker positions have stops — run DB audit for supplemental detail
      const auditTrades = openTrades.map((t: any) => ({
        id: String(t.id || ""),
        ticker: String(t.ticker || ""),
        side: String(t.side || ""),
        status: String(t.status || ""),
        stopOrderId: t.stopOrderId || t.alpacaStopOrderId,
      }));
      protectionAudit = auditProtectionIntegrity({
        openTrades: auditTrades,
        brokerPositions,
        brokerOrders,
      });
      // DB incidents that don't correspond to live broker positions are stale
      protectionCritical = !protectionAudit.ok;
      protectionIsStaleOnly = !protectionAudit.ok && brokerIsFlat;
    } else {
      // Broker is flat — any DB incidents are stale reconciliation issues
      if (openTrades.length > 0) {
        const auditTrades = openTrades.map((t: any) => ({
          id: String(t.id || ""),
          ticker: String(t.ticker || ""),
          side: String(t.side || ""),
          status: String(t.status || ""),
          stopOrderId: t.stopOrderId || t.alpacaStopOrderId,
        }));
        protectionAudit = auditProtectionIntegrity({
          openTrades: auditTrades,
          brokerPositions,
          brokerOrders,
        });
        protectionIsStaleOnly = true;
        protectionCritical = false;
      }
    }
  } else {
    // Fail-closed: if broker unavailable, assume critical when trades exist
    protectionCritical = openTrades.length > 0;
  }

  const signals: any[] = Array.isArray(allSignals) ? allSignals : [];

  // Use shared ET-day utilities for consistent filtering
  const { startMs: dayStartMs, endMs: dayEndMs } = getEtDayBoundsMs(todayEt);

  const signalsToday = signals.filter((s) => {
    const createdAt = s?.createdAt;
    if (createdAt == null) return false;
    // Handle both numeric timestamps and ISO strings
    let t: number;
    if (typeof createdAt === "number" && Number.isFinite(createdAt)) {
      t = createdAt;
    } else {
      t = Date.parse(createdAt);
    }
    if (!Number.isFinite(t)) return false;
    return t >= dayStartMs && t < dayEndMs;
  });

  const scoredToday = signalsToday.filter((s) => (s?.status || "").toUpperCase() === "SCORED");
  const pendingToday = signalsToday.filter((s) => (s?.status || "").toUpperCase() === "PENDING");
  
  // Also count qualified signals for alignment with funnel-health
  const qualifiedToday = signalsToday.filter((s) => s?.qualified === true);
  
  const scoresToday = scoredToday
    .map((s) => s?.aiScore)
    .filter((x: any) => typeof x === "number" && Number.isFinite(x));

  const maxScoreToday = scoresToday.length ? Math.max(...scoresToday) : null;
  const avgScoreToday = scoresToday.length
    ? scoresToday.reduce((a: number, b: number) => a + b, 0) / scoresToday.length
    : null;

  // Direct funnel read (bypasses auth issues for cron callers)
  let directFunnel: Record<string, any> | null = null;
  try {
    directFunnel = await readTodayFunnel();
  } catch {}

  const funnelToday = funnel?.today ?? directFunnel ?? {};
  // Prefer direct funnel if the HTTP-fetched funnel is empty
  const effectiveFunnel = (funnelToday?.scansRun != null) ? funnelToday : (directFunnel ?? funnelToday);
  const lastScanAt = effectiveFunnel?.lastScanAt ?? null;
  const lastScanStatus = effectiveFunnel?.lastScanStatus ?? null;
  const lastScanMode = effectiveFunnel?.lastScanMode ?? null;
  const lastScanSource = effectiveFunnel?.lastScanSource ?? null;
  const minsSinceLastScan = minutesSince(lastScanAt);

  const aiStatus = (aiHealth?.status || "").toString();

  const clock = await fetchAlpacaClockSafe();
  const marketStatus = clock.ok ? (clock.is_open ? "OPEN" : "CLOSED") : "UNKNOWN";

  const marketOpen = marketStatus.toUpperCase() === "OPEN";
  const aiHealthy = aiStatus.toUpperCase() === "HEALTHY";

  const SCAN_STALE_MINUTES = Number(process.env.READINESS_SCAN_STALE_MINUTES ?? 10);
  const SIGNALS_STALE_MINUTES = Number(process.env.READINESS_SIGNALS_STALE_MINUTES ?? 15);

  const scannerRecent =
    !marketOpen || (minsSinceLastScan != null && minsSinceLastScan <= SCAN_STALE_MINUTES);

  const scannerRunningWhenOpen =
    !marketOpen || ["RUN", "SKIP"].includes(String(lastScanStatus || "").toUpperCase());

  const lastScoredAt = scoredToday.length
    ? scoredToday
        .map((s) => s?.createdAt)
        .filter(Boolean)
        .sort()
        .slice(-1)[0]
    : null;
  const minsSinceLastScore = minutesSince(lastScoredAt);

  const scoringFlowing =
    !marketOpen ||
    (scoredToday.length > 0 &&
      (minsSinceLastScore == null || minsSinceLastScore <= SIGNALS_STALE_MINUTES));

  // Track if backlog is growing (scoring falling behind intake)
  const scoringBacklogWarning =
    marketOpen && pendingToday.length > 50 && scoredToday.length < pendingToday.length;

  // --- Broker truth for max open positions check ---
  const brokerPositionsCount =
    typeof brokerTruth.positionsCount === "number"
      ? brokerTruth.positionsCount
      : Array.isArray(brokerTruth.positions)
        ? brokerTruth.positions.length
        : 0;

  const wouldSkipMaxOpenPositions = brokerTruth.error
    ? null
    : brokerPositionsCount >= guardConfig.maxOpenPositions;

  const checks: Check[] = [
    {
      name: "market_open",
      ok: marketOpen,
      detail: `market=${marketStatus || "UNKNOWN"}`,
    },
    {
      name: "ai_healthy",
      ok: publicMode ? true : !marketOpen ? true : aiHealthy,
      detail: `ai=${aiStatus || "UNKNOWN"}`,
    },
    {
      name: "scanner_running",
      ok: publicMode ? true : scannerRunningWhenOpen,
      detail: !marketOpen
        ? "market closed; scanner run not required"
        : `lastScanStatus=${lastScanStatus || "?"} mode=${lastScanMode || "?"} source=${lastScanSource || "?"}`,
    },
    {
      name: "scanner_recent",
      ok: publicMode ? true : scannerRecent,
      detail: !marketOpen
        ? "market closed; scanner freshness not required"
        : `lastScan=${lastScanAt || "none"} (${minsSinceLastScan?.toFixed(1) ?? "?"}m) status=${lastScanStatus || "?"}`,
    },
    {
      name: "scoring_flowing",
      ok: publicMode ? true : scoringFlowing,
      detail: !marketOpen
        ? "market closed; scoring freshness not required"
        : `scoredToday=${scoredToday.length} pending=${pendingToday.length} lastScore=${lastScoredAt || "none"} (${minsSinceLastScore?.toFixed(1) ?? "?"}m)${scoringBacklogWarning ? " [BACKLOG WARNING]" : ""}`,
    },
    {
      name: "max_open_positions",
      ok: publicMode ? true : wouldSkipMaxOpenPositions === null ? true : !wouldSkipMaxOpenPositions,
      detail: brokerTruth.error
        ? `broker_error: ${brokerTruth.error}`
        : `broker positions: ${brokerPositionsCount} / max: ${guardConfig.maxOpenPositions}`,
    },
    {
      name: "protection_integrity",
      // NOTE: Never bypassed by publicMode — broker safety is always real.
      ok: !protectionCritical,
      detail: protectionCritical
        ? unprotectedBrokerPositions.length > 0
          ? `CRITICAL: ${unprotectedBrokerPositions.length} broker position(s) without stop [${unprotectedBrokerPositions.slice(0, 8).join(",")}]`
          : protectionAudit
            ? `CRITICAL: ${protectionAudit.criticalCount} incident(s) [${protectionAudit.incidents
                .filter((i) => i.severity === "CRITICAL")
                .map((i) => `${i.symbol}:${i.code}`)
                .slice(0, 8)
                .join(",")}]`
            : brokerTruth.error
              ? `broker_error: ${brokerTruth.error}; ${openTrades.length} open trade(s) unverifiable`
              : `CRITICAL: ${openTrades.length} open trade(s) without verified stop`
        : protectionIsStaleOnly
          ? `broker_flat_stale_mismatch: ${openTrades.length} DB trade(s) need reconciliation (no live risk)`
          : protectionAudit?.protectedOrphanSymbols?.length
            ? `ok; protected_open_trades=${openTrades.length}; protected_orphans_need_reconciliation=[${protectionAudit.protectedOrphanSymbols.join(",")}]`
            : `ok; protected_open_trades=${openTrades.length}`,
    },
  ];

  const reasons = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail || "failed"}`);
  const ready = checks.every((c) => c.ok);

  return NextResponse.json({
    ok: true,
    ready,
    // ─── Operational summary: single-glance system health ───────────
    operationalSummary: {
      brokerRisk: protectionCritical
        ? "CRITICAL"
        : protectionIsStaleOnly
          ? "STALE_MISMATCH"
          : "CLEAR",
      unprotectedBrokerPositions: unprotectedBrokerPositions.length > 0 ? unprotectedBrokerPositions : undefined,
      protectedOrphanSymbols: protectionAudit?.protectedOrphanSymbols?.length ? protectionAudit.protectedOrphanSymbols : undefined,
      queueHealth: marketOpen ? "ok" : "market_closed",
      funnelFlow: !marketOpen
        ? "market_closed"
        : (effectiveFunnel?.scansRun ?? 0) > 0 && scoredToday.length > 0
          ? "flowing"
          : (effectiveFunnel?.scansRun ?? 0) > 0
            ? "scanning_no_scores"
            : (effectiveFunnel?.scansSkipped ?? 0) > 0
              ? "scanning_but_skipping"
              : "no_scans",
      brokerIsFlat,
    },
    timestamp: new Date().toISOString(),
    etDate: todayEt,
    market: {
      status: marketStatus || "UNKNOWN",
      isOpen: clock.ok ? Boolean(clock.is_open) : null,
      nextOpen: clock.ok ? (clock.next_open ?? null) : null,
      nextClose: clock.ok ? (clock.next_close ?? null) : null,
      clock: clock.ok
        ? {
            is_open: clock.is_open,
            timestamp: clock.timestamp,
            next_open: clock.next_open,
            next_close: clock.next_close,
          }
        : { error: clock.error, status: (clock as any).status ?? null },
    },
    ai: { status: aiStatus || "UNKNOWN" },
    scanner: {
      lastScanAt,
      lastScanMode,
      lastScanSource,
      lastScanStatus,
      minsSinceLastScan,
      scansRun: effectiveFunnel?.scansRun ?? null,
      scansSkipped: effectiveFunnel?.scansSkipped ?? null,
      scanRunsByMode: effectiveFunnel?.scanRunsByMode ?? null,
      scanSkipsByMode: effectiveFunnel?.scanSkipsByMode ?? null,
      signalsPosted: effectiveFunnel?.signalsPosted ?? null,
      signalsReceived: effectiveFunnel?.signalsReceived ?? null,
    },
    today: {
      totalSignals: signalsToday.length,
      scored: scoredToday.length,
      qualified: qualifiedToday.length,
      pending: pendingToday.length,
      avgScore: avgScoreToday,
      maxScore: maxScoreToday,
      lastScoredAt,
      // Signal flow diagnostics
      signalSourceUsed: "direct_redis_read",
      recentSignalsWindowUsed: todayEt,
      etDayBounds: { startMs: dayStartMs, endMs: dayEndMs },
      recentSignalsFound: signalsToday.length,
      recentScoredFound: scoredToday.length,
      recentQualifiedFound: qualifiedToday.length,
      storeTotal: signals.length,
      funnelScansRun: effectiveFunnel?.scansRun ?? 0,
      funnelSignalsPosted: effectiveFunnel?.signalsPosted ?? 0,
      funnelGptScored: effectiveFunnel?.gptScored ?? 0,
    },
    autoEntry: {
      etDateUsed: todayEt,
      guardKeyUsed,
      enabled: toggleState.enabled,
      envEnabled: guardConfig.enabled,
      toggleReason: toggleState.reason,
      entriesToday: guardState.entriesToday,
      maxEntriesPerDay: guardConfig.maxEntriesPerDay,
      consecutiveFailures: guardState.consecutiveFailures,
      maxConsecutiveFailures: guardConfig.maxConsecutiveFailures,
      autoDisabledReason: guardState.autoDisabledReason,
      lastFailureAt: guardState.lastFailureAt,
      lastFailureReason: guardState.lastFailureReason,
      lastFailureRunId: guardState.lastFailureRunId,
      lastFailureTradeId: guardState.lastFailureTradeId,
      maxOpenPositions: guardConfig.maxOpenPositions,
      lastLossAt: guardState.lastLossAt,
      // Broker truth for open positions (not DB)
      brokerPositionsCount,
      brokerOpenOrdersCount:
        typeof brokerTruth.openOrdersCount === "number"
          ? brokerTruth.openOrdersCount
          : Array.isArray(brokerTruth.openOrders)
            ? brokerTruth.openOrders.length
            : 0,
      wouldSkipMaxOpenPositions,
      brokerError: brokerTruth.error || null,
    },
    // ─── Market-open funnel flow diagnostics ────────────────────────
    funnelFlowDiagnostics: marketOpen ? (() => {
      const scansRun = effectiveFunnel?.scansRun ?? 0;
      const scansSkipped = effectiveFunnel?.scansSkipped ?? 0;
      const scanStatus = lastScanStatus;
      const signalsPostedCount = effectiveFunnel?.signalsPosted ?? 0;

      let stoppedAt = "flowing";
      let stoppedReason = "funnel is flowing normally";

      if (scansRun === 0 && scansSkipped === 0) {
        stoppedAt = "scan";
        stoppedReason = "no scans have run today — cron/scheduler may not be triggering";
      } else if (scansRun === 0 && scansSkipped > 0) {
        stoppedAt = "scan";
        stoppedReason = `${scansSkipped} scan(s) skipped (status=${scanStatus || "?"}) — scanner running but skipping`;
      } else if (scansRun > 0 && signalsPostedCount === 0) {
        stoppedAt = "signal_post";
        stoppedReason = `${scansRun} scan(s) ran but 0 signals posted`;
      } else if (signalsPostedCount > 0 && signalsToday.length === 0) {
        stoppedAt = "signal_post";
        stoppedReason = `${signalsPostedCount} posted but 0 found in today's window`;
      } else if (signalsToday.length > 0 && scoredToday.length === 0) {
        stoppedAt = "scoring";
        stoppedReason = `${signalsToday.length} signals but 0 scored — drain may not have run`;
      } else if (scoredToday.length > 0 && qualifiedToday.length === 0) {
        stoppedAt = "qualification";
        stoppedReason = `${scoredToday.length} scored but 0 qualified`;
      }

      return { stoppedAt, stoppedReason };
    })() : null,
    // ─── Broker/DB reconciliation awareness ─────────────────────────
    brokerReconciliation: protectionIsStaleOnly ? {
      brokerIsFlat,
      staleMismatchCount: openTrades.length,
      staleTickers: openTrades.slice(0, 5).map((t: any) => String(t.ticker || "").toUpperCase()),
      message: "Broker is flat but DB has open trades — needs reconciliation, no live risk",
    } : null,
    checks,
    reasons,
    mode: publicMode ? "public" : "authed",
  });
}
