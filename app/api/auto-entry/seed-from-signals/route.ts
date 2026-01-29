import { NextRequest, NextResponse } from "next/server";
import { readSignals } from "@/lib/jsonDb";
import { readTrades, upsertTrade } from "@/lib/tradesStore";
import { alpacaRequest } from "@/lib/alpaca";
import { getAutoConfig, tierForScore } from "@/lib/autoEntry/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


function round2(n: number) {
  return Number(Number(n).toFixed(2));
}

function ensureLegsLong(basePrice: number, stopPrice: number, takeProfitPrice: number) {
  const base = Number(basePrice);
  let sl = Number(stopPrice);
  let tp = Number(takeProfitPrice);
  const min = 0.01;
  if (!(tp >= base + min)) tp = round2(base + min);
  if (!(sl <= base - min)) sl = round2(base - min);
  return { stopPrice: sl, takeProfitPrice: tp };
}

async function fetchBasePrice(ticker: string): Promise<number | null> {
  const enc = encodeURIComponent(ticker);

  const q = await alpacaRequest({ method: "GET", path: `/v2/stocks/${enc}/quotes/latest` });
  if (q.ok && q.text) {
    try {
      const parsed = JSON.parse(q.text || "{}");
      const qt = (parsed as any)?.quote || (parsed as any)?.quotes?.[0] || parsed;
      const ap = Number(qt?.ap ?? qt?.ask_price ?? qt?.ask ?? NaN);
      const bp = Number(qt?.bp ?? qt?.bid_price ?? qt?.bid ?? NaN);
      const lp = Number(qt?.lp ?? qt?.last_price ?? qt?.p ?? qt?.price ?? NaN);
      if (ap > 0 && bp > 0) return (ap + bp) / 2;
      if (lp > 0) return lp;
      if (ap > 0) return ap;
      if (bp > 0) return bp;
    } catch {}
  }

  const t = await alpacaRequest({ method: "GET", path: `/v2/stocks/${enc}/trades/latest` });
  if (t.ok && t.text) {
    try {
      const parsed = JSON.parse(t.text || "{}");
      const tr = (parsed as any)?.trade || (parsed as any)?.trades?.[0] || parsed;
      const px = Number(tr?.p ?? tr?.price ?? NaN);
      if (px > 0) return px;
    } catch {}
  }

  return null;
}

function computeSeedPrices(base: number) {
  const entryPrice = round2(base);
  const rawStop = round2(base * 0.99);
  const risk = Math.abs(entryPrice - rawStop);
  const rawTp = round2(entryPrice + risk * 2.0);
  const legs = ensureLegsLong(entryPrice, rawStop, rawTp);
  return { entryPrice, stopPrice: legs.stopPrice, takeProfitPrice: legs.takeProfitPrice };
}

function etDate(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
}

export async function POST(req: NextRequest) {
  const cronToken = req.headers.get("x-cron-token") || "";
  const autoToken = req.headers.get("x-auto-entry-token") || "";

  const okCron = !!process.env.CRON_TOKEN && cronToken === process.env.CRON_TOKEN;
  const okAuto = !!process.env.AUTO_ENTRY_TOKEN && autoToken === process.env.AUTO_ENTRY_TOKEN;

  if (!okCron && !okAuto) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const cfg = getAutoConfig();
  if (!cfg.enabled) {
    return NextResponse.json({ ok: true, skipped: true, reason: "AUTO_TRADING_ENABLED=false" }, { status: 200 });
  }

  // Parse query params from URL (not from JSON body)
  const url = new URL(req.url);
  const limitRaw = url.searchParams.get("limit");
  const minScoreRaw = url.searchParams.get("minScore");

  const limitParsed = Number(limitRaw);
  const minScoreParsed = Number(minScoreRaw);

  // Apply defaults and bounds
  const limit = Number.isFinite(limitParsed)
    ? Math.max(1, Math.min(50, limitParsed))
    : Math.max(1, Math.min(10, Number(process.env.AUTO_SEED_LIMIT ?? "3")));

  const minScore = Number.isFinite(minScoreParsed)
    ? minScoreParsed
    : Number(process.env.AUTO_SEED_MIN_SCORE ?? "7.5");

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


    const base = await fetchBasePrice(ticker);
    if (!base) {
      skipped.push({ ticker, signalId, reason: "no_base_price" });
      continue;
    }
    const { entryPrice, stopPrice, takeProfitPrice } = computeSeedPrices(base);

    const now = new Date().toISOString();

    const trade = {
      id: crypto.randomUUID(),
      ticker,
      side: "LONG",
      entryPrice,
      stopPrice,
      takeProfitPrice,
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
      // Echo raw query params for prod visibility
      receivedQuery: {
        limitRaw,
        minScoreRaw,
      },
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
