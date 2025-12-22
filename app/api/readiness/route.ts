export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";

type Check = {
  name: string;
  ok: boolean;
  detail?: string;
};

function etDateString(d: Date): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

function minutesSince(iso?: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 60000;
}

export async function GET(req: Request) {
  const authed = await requireAuth(req);
  if (!authed.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const base = `${url.protocol}//${url.host}`;
  const cookie = req.headers.get("cookie") || "";

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

  const aiHealth = await aiHealthResp.json();
  const funnel = await funnelResp.json();
  const signalsPayload = await signalsResp.json();

  const todayEt = etDateString(new Date());

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

  let marketStatus = (aiHealth?.market?.status || aiHealth?.marketStatus || "").toString();
  if (!marketStatus) {
    if (aiStatus.toUpperCase() === "MARKET_CLOSED") marketStatus = "CLOSED";
  }
  if (!marketStatus) marketStatus = "UNKNOWN";

  const marketOpen = marketStatus.toUpperCase() === "OPEN";
  const aiHealthy = aiStatus.toUpperCase() === "HEALTHY";

  const SCAN_STALE_MINUTES = Number(process.env.READINESS_SCAN_STALE_MINUTES ?? 10);
  const SIGNALS_STALE_MINUTES = Number(process.env.READINESS_SIGNALS_STALE_MINUTES ?? 15);

  const scannerRecent =
    !marketOpen ||
    (minsSinceLastScan != null && minsSinceLastScan <= SCAN_STALE_MINUTES);

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
      ok: !marketOpen ? true : aiHealthy,
      detail: `ai=${aiStatus || "UNKNOWN"}`,
    },
    {
      name: "scanner_recent",
      ok: scannerRecent,
      detail: !marketOpen
        ? "market closed; scanner freshness not required"
        : `lastScan=${lastScanAt || "none"} (${minsSinceLastScan?.toFixed(1) ?? "?"}m) status=${lastScanStatus || "?"}`,
    },
    {
      name: "scoring_flowing",
      ok: scoringFlowing,
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
    market: { status: marketStatus || "UNKNOWN" },
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
    checks,
    reasons,
  });
}
