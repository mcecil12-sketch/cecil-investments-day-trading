export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getGuardrailConfig, etDateString, minutesSince } from "@/lib/autoEntry/guardrails";
import * as guardrailsStore from "@/lib/autoEntry/guardrailsStore";

type Check = {
  name: string;
  ok: boolean;
  detail?: string;
};

async function fetchAlpacaClock(): Promise<
  | { ok: true; is_open: boolean; timestamp?: string; next_open?: string; next_close?: string }
  | { ok: false; error: string; status?: number }
> {
  const base =
    process.env.ALPACA_BASE_URL ||
    process.env.ALPACA_TRADING_BASE_URL ||
    "https://paper-api.alpaca.markets";

  const key =
    process.env.ALPACA_API_KEY ||
    process.env.ALPACA_API_KEY_ID ||
    process.env.ALPACA_KEY_ID ||
    "";

  const secret =
    process.env.ALPACA_API_SECRET ||
    process.env.ALPACA_API_SECRET_KEY ||
    process.env.ALPACA_SECRET_KEY ||
    "";

  if (!key || !secret) {
    return { ok: false, error: "missing_alpaca_keys" };
  }

  const resp = await fetch(`${base.replace(/\/$/, "")}/v2/clock`, {
    headers: {
      "APCA-API-KEY-ID": key,
      "APCA-API-SECRET-KEY": secret,
    },
    cache: "no-store",
  });

  if (!resp.ok) {
    return { ok: false, error: "alpaca_clock_failed", status: resp.status };
  }

  const json = await resp.json();
  return {
    ok: true,
    is_open: Boolean(json?.is_open),
    timestamp: json?.timestamp,
    next_open: json?.next_open,
    next_close: json?.next_close,
  };
}

export async function GET(req: Request) {
  const authed = await requireAuth(req);
  const publicMode = !authed.ok;

  const url = new URL(req.url);
  const base = `${url.protocol}//${url.host}`;
  const cookie = req.headers.get("cookie") || "";

  let aiHealth: any = { status: "UNKNOWN" };
  let funnel: any = { today: {} };
  let signalsPayload: any = { signals: [] };

  if (!publicMode) {
    const [aiHealthResp, funnelResp, signalsResp] = await Promise.all([
      fetch(`${base}/api/ai-health`, { headers: { cookie }, cache: "no-store" }),
      fetch(`${base}/api/funnel-stats`, { headers: { cookie }, cache: "no-store" }),
      fetch(`${base}/api/signals/all`, { headers: { cookie }, cache: "no-store" }),
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
    if (!signalsResp.ok) {
      return NextResponse.json(
        { ok: false, error: "upstream_signals_failed", status: signalsResp.status },
        { status: 502 }
      );
    }

    aiHealth = await aiHealthResp.json();
    funnel = await funnelResp.json();
    signalsPayload = await signalsResp.json();
  } else {
    try {
      const fr = await fetch(`${base}/api/funnel-stats`, { cache: "no-store" });
      if (fr.ok) funnel = await fr.json();
    } catch {}
  }

  const todayEt = etDateString(new Date());
  const guardConfig = getGuardrailConfig();
  const [guardState, toggleState] = await Promise.all([
    guardrailsStore.getGuardrailsState(todayEt),
    guardrailsStore.getAutoEntryEnabledState(guardConfig),
  ]);

  const signals: any[] = Array.isArray(signalsPayload)
    ? signalsPayload
    : signalsPayload?.signals ?? [];

  const signalsToday = signals.filter((s) => {
    const createdAt = s?.createdAt;
    if (!createdAt) return false;
    const t = Date.parse(createdAt);
    if (!Number.isFinite(t)) return false;
    return etDateString(new Date(t)) === todayEt;
  });

  const scoredToday = signalsToday.filter((s) => (s?.status || "").toUpperCase() === "SCORED");
  const scoresToday = scoredToday
    .map((s) => s?.aiScore)
    .filter((x: any) => typeof x === "number" && Number.isFinite(x));

  const maxScoreToday = scoresToday.length ? Math.max(...scoresToday) : null;
  const avgScoreToday = scoresToday.length
    ? scoresToday.reduce((a: number, b: number) => a + b, 0) / scoresToday.length
    : null;

  const funnelToday = funnel?.today ?? {};
  const lastScanAt = funnelToday?.lastScanAt ?? null;
  const lastScanStatus = funnelToday?.lastScanStatus ?? null;
  const lastScanMode = funnelToday?.lastScanMode ?? null;
  const lastScanSource = funnelToday?.lastScanSource ?? null;
  const minsSinceLastScan = minutesSince(lastScanAt);

  const aiStatus = (aiHealth?.status || "").toString();

  const clock = await fetchAlpacaClock();
  const marketStatus = clock.ok ? (clock.is_open ? "OPEN" : "CLOSED") : "UNKNOWN";

  const marketOpen = marketStatus.toUpperCase() === "OPEN";
  const aiHealthy = aiStatus.toUpperCase() === "HEALTHY";

  const SCAN_STALE_MINUTES = Number(process.env.READINESS_SCAN_STALE_MINUTES ?? 10);
  const SIGNALS_STALE_MINUTES = Number(process.env.READINESS_SIGNALS_STALE_MINUTES ?? 15);

  const scannerRecent =
    !marketOpen || (minsSinceLastScan != null && minsSinceLastScan <= SCAN_STALE_MINUTES);

  const scannerRunningWhenOpen =
    !marketOpen || (String(lastScanStatus || "").toUpperCase() === "RUN");

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
        : `scoredToday=${scoredToday.length} lastScore=${lastScoredAt || "none"} (${minsSinceLastScore?.toFixed(1) ?? "?"}m)`,
    },
  ];

  const reasons = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail || "failed"}`);
  const ready = checks.every((c) => c.ok);

  return NextResponse.json({
    ok: true,
    ready,
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
      scansRun: funnelToday?.scansRun ?? null,
      scansSkipped: funnelToday?.scansSkipped ?? null,
      scanRunsByMode: funnelToday?.scanRunsByMode ?? null,
      scanSkipsByMode: funnelToday?.scanSkipsByMode ?? null,
    },
    today: {
      totalSignals: signalsToday.length,
      scored: scoredToday.length,
      avgScore: avgScoreToday,
      maxScore: maxScoreToday,
      lastScoredAt,
    },
    autoEntry: {
      enabled: toggleState.enabled,
      envEnabled: guardConfig.enabled,
      toggleReason: toggleState.reason,
      entriesToday: guardState.entriesToday,
      maxEntriesPerDay: guardConfig.maxEntriesPerDay,
      consecutiveFailures: guardState.consecutiveFailures,
      maxConsecutiveFailures: guardConfig.maxConsecutiveFailures,
      autoDisabledReason: guardState.autoDisabledReason,
      maxOpenPositions: guardConfig.maxOpenPositions,
      lastLossAt: guardState.lastLossAt,
    },
    checks,
    reasons,
    mode: publicMode ? "public" : "authed",
  });
}
