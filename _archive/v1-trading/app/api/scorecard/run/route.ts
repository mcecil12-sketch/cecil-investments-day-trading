import { NextResponse } from "next/server";
import { requireMarketLoopOnly } from "@/lib/scorecard/runSource";
import { computeDailyScorecard } from "@/lib/scorecard/compute";
import { writeDailyScorecard } from "@/lib/scorecard/redis";

export const dynamic = "force-dynamic";

function dateETNow(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date()); // YYYY-MM-DD
}

async function fetchJson(url: string, headers: Record<string, string>) {
  const resp = await fetch(url, { headers, cache: "no-store" });
  const text = await resp.text();
  if (!resp.ok) {
    return { ok: false as const, status: resp.status, text };
  }
  try {
    return { ok: true as const, json: JSON.parse(text) };
  } catch {
    return { ok: false as const, status: 500, text: "invalid_json" };
  }
}

export async function POST(req: Request) {
  const guard = requireMarketLoopOnly(new Headers(req.headers));
  if (!guard.ok) {
    return NextResponse.json(guard.body, { status: guard.status });
  }

  const enabled = (process.env.SCORECARD_ENABLED ?? "1") === "1";
  if (!enabled) {
    return NextResponse.json({ ok: true, skipped: true, reason: "scorecard_disabled", runSource: guard.runSource, runId: guard.runId });
  }

  const { searchParams } = new URL(req.url);
  const dateET = searchParams.get("dateET") || dateETNow();

  // Pull from existing performance endpoint (server-side, no auth cookie).
  // This assumes /api/performance/analytics is allowlisted already (it is per prior fix).
  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL ||
    process.env.VERCEL_URL?.startsWith("http")
      ? process.env.VERCEL_URL
      : process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "";

  if (!baseUrl) {
    return NextResponse.json({ ok: false, error: "missing_base_url", hint: "Set NEXT_PUBLIC_BASE_URL or VERCEL_URL in environment." }, { status: 500 });
  }

  const headers = { "Content-Type": "application/json" };
  const analyticsUrl = `${baseUrl}/api/performance/analytics?range=all`;
  const portfolioUrl = `${baseUrl}/api/performance/portfolio`;

  const [analyticsRes, portfolioRes] = await Promise.all([
    fetchJson(analyticsUrl, headers),
    fetchJson(portfolioUrl, headers),
  ]);

  if (!analyticsRes.ok) {
    return NextResponse.json({ ok: false, error: "analytics_fetch_failed", status: analyticsRes.status, text: analyticsRes.text }, { status: 500 });
  }
  if (!portfolioRes.ok) {
    return NextResponse.json({ ok: false, error: "portfolio_fetch_failed", status: portfolioRes.status, text: portfolioRes.text }, { status: 500 });
  }

  const analytics = analyticsRes.json;
  const portfolio = portfolioRes.json;

  const startingBalance = Number(portfolio?.startingBalance ?? 100000);
  const totals = analytics?.totals ?? {};
  const trades = Number(totals?.trades ?? 0);
  const wins = Number(totals?.wins ?? 0);
  const losses = Number(totals?.losses ?? 0);
  const winRate = Number(totals?.winRate ?? 0);
  const realizedPnL = Number(totals?.realizedPnL ?? 0);
  const realizedR = Number(totals?.realizedR ?? 0);
  const avgR = Number(totals?.avgR ?? 0);

  const card = computeDailyScorecard({
    dateET,
    startingBalance,
    realizedPnL,
    trades,
    wins,
    losses,
    winRate,
    realizedR,
    avgR,
  });

  const stored = await writeDailyScorecard(dateET, card);
  return NextResponse.json({
    ok: true,
    dateET,
    runSource: guard.runSource,
    runId: guard.runId,
    stored,
    scorecard: card,
  });
}

