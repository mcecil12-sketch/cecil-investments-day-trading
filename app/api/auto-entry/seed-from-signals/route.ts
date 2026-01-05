import { NextResponse } from "next/server";
import { readSignals } from "@/lib/jsonDb";
import { readTrades, upsertTrade } from "@/lib/tradesStore";
import { getAutoConfig, tierForScore } from "@/lib/autoEntry/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function etDate(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
}

export async function POST(req: Request) {
  const token = req.headers.get("x-cron-token") || "";
  if (!process.env.CRON_TOKEN || token !== process.env.CRON_TOKEN) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const cfg = getAutoConfig();
  if (!cfg.enabled) {
    return NextResponse.json({ ok: true, skipped: true, reason: "AUTO_TRADING_ENABLED=false" }, { status: 200 });
  }

  let body: Partial<{ limit: number; minScore: number }> = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {}

  const limit = Math.max(0, Math.min(10, Number(body.limit ?? process.env.AUTO_SEED_LIMIT ?? "3")));
  const minScore = Number(body.minScore ?? process.env.AUTO_SEED_MIN_SCORE ?? "7.5");
  const today = etDate();

  const [signals, trades] = await Promise.all([readSignals(), readTrades<any>()]);

  const existingBySignalId = new Set<string>();
  const existingByTickerToday = new Set<string>();

  for (const t of trades || []) {
    const sid = String(t?.signalId || "");
    if (sid) existingBySignalId.add(sid);

    const createdAt = String(t?.createdAt || "");
    const ticker = String(t?.ticker || "").toUpperCase();
    if (ticker && createdAt.startsWith(today)) existingByTickerToday.add(ticker);
  }

  const candidates = (signals || [])
    .filter((s: any) => {
      if (!s) return false;
      const createdAt = String(s.createdAt || "");
      if (!createdAt.startsWith(today)) return false;
      if (s.shownInApp !== true) return false;
      if (String(s.status || "").toUpperCase() !== "SCORED") return false;
      const score = Number(s.score ?? 0);
      if (!Number.isFinite(score) || score < minScore) return false;
      const ticker = String(s.ticker || "").toUpperCase();
      if (!ticker) return false;
      return true;
    })
    .sort((a: any, b: any) => Number(b.score ?? 0) - Number(a.score ?? 0));

  const created: any[] = [];
  const skipped: any[] = [];

  for (const s of candidates) {
    if (created.length >= limit) break;

    const signalId = String(s.id || "");
    const ticker = String(s.ticker || "").toUpperCase();
    const score = Number(s.score ?? 0);

    if (signalId && existingBySignalId.has(signalId)) {
      skipped.push({ ticker, signalId, reason: "already_has_trade_for_signal" });
      continue;
    }

    if (existingByTickerToday.has(ticker)) {
      skipped.push({ ticker, signalId, reason: "already_has_trade_for_ticker_today" });
      continue;
    }

    const tier = tierForScore(score) || "C";
    if (tier === "C" && !cfg.allowedTiers.includes("C")) {
      skipped.push({ ticker, signalId, reason: "tier_c_disabled" });
      continue;
    }

    const now = new Date().toISOString();

    const trade = {
      id: crypto.randomUUID(),
      ticker,
      status: "AUTO_PENDING",
      source: "AUTO",
      paper: true,
      createdAt: now,
      updatedAt: now,
      signalId,
      score,
      tier,
      autoEntryStatus: "AUTO_PENDING",
    };

    await upsertTrade(trade);

    existingBySignalId.add(signalId);
    existingByTickerToday.add(ticker);
    created.push({ id: trade.id, ticker, signalId, score, tier });
  }

  return NextResponse.json(
    {
      ok: true,
      today,
      limit,
      minScore,
      totalSignals: (signals || []).length,
      totalCandidates: candidates.length,
      createdCount: created.length,
      skippedCount: skipped.length,
      created,
      skipped: skipped.slice(0, 50),
    },
    { status: 200 }
  );
}
