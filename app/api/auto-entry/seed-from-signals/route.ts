import { NextRequest, NextResponse } from "next/server";
import { readTrades, upsertTrade } from "@/lib/tradesStore";
import { getAutoConfig, tierForScore } from "@/lib/autoEntry/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RawSignal = Record<string, any>;

function getNum(obj: any, paths: string[]): number | null {
  for (const path of paths) {
    const parts = path.split(".");
    let cur: any = obj;
    for (const p of parts) {
      if (cur == null) {
        cur = undefined;
        break;
      }
      cur = cur[p];
    }
    if (cur == null || cur === "") continue;
    const n = Number(cur);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function getSymbol(signal: RawSignal): string {
  const raw = signal?.symbol ?? signal?.ticker;
  return String(raw || "").trim().toUpperCase();
}

function normalizeDirection(raw: any): "LONG" | "SHORT" | null {
  const d = String(raw || "").trim().toUpperCase();
  if (d === "LONG" || d === "SHORT") return d;
  return null;
}

function getDirection(signal: RawSignal): "LONG" | "SHORT" | null {
  return (
    normalizeDirection(signal?.bestDirection) ||
    normalizeDirection(signal?.direction) ||
    normalizeDirection(signal?.aiDirection) ||
    normalizeDirection(signal?.side)
  );
}

function parseSignalsPayload(payload: any): RawSignal[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.signals)) return payload.signals;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

async function fetchScoredSignalsFromInternalApi(): Promise<RawSignal[]> {
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? "http://127.0.0.1:3000";
  const url = `${base.replace(/\/$/, "")}/api/signals/all?since=48h&onlyActive=1&order=desc&limit=1000&statuses=SCORED`;
  const resp = await fetch(url, { method: "GET", cache: "no-store" });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`signals_all_fetch_failed:${resp.status}:${text.slice(0, 200)}`);
  }
  const json = await resp.json().catch(() => ({}));
  return parseSignalsPayload(json);
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
    : 1;

  const minScore = Number.isFinite(minScoreParsed)
    ? minScoreParsed
    : 0;

  const today = etDate();

  const [signals, trades] = await Promise.all([
    fetchScoredSignalsFromInternalApi(),
    readTrades<any>(),
  ]);

  const existingBySignalId = new Set<string>();
  const existingPendingBySymbolSide = new Set<string>();

  for (const t of trades || []) {
    const sid = String(t?.signalId || "");
    if (sid) existingBySignalId.add(sid);

    const status = String(t?.status || "").toUpperCase();
    const symbol = String(t?.ticker || t?.symbol || "").toUpperCase();
    const side = normalizeDirection(t?.side);
    if (status === "AUTO_PENDING" && symbol && side) {
      existingPendingBySymbolSide.add(`${symbol}:${side}`);
    }
  }

  const created: any[] = [];
  const skipped: any[] = [];

  const seenCandidateSymbolSide = new Set<string>();
  let totalCandidates = 0;

  const sortedSignals = [...(signals || [])].sort(
    (a: any, b: any) =>
      (getNum(b, ["aiScore", "score"]) ?? Number.NEGATIVE_INFINITY) -
      (getNum(a, ["aiScore", "score"]) ?? Number.NEGATIVE_INFINITY)
  );

  for (const s of sortedSignals) {

    const status = String(s?.status || "").toUpperCase();
    if (status !== "SCORED") continue;
    if (s?.qualified !== true) {
      skipped.push({ symbol: getSymbol(s) || "UNKNOWN", reason: "not_qualified" });
      continue;
    }

    const symbol = getSymbol(s);
    if (!symbol) {
      skipped.push({ symbol: "UNKNOWN", reason: "missing_symbol" });
      continue;
    }

    const side = getDirection(s);
    if (!side) {
      skipped.push({ symbol, reason: "missing_direction" });
      continue;
    }

    const aiScore = getNum(s, ["aiScore", "score"]);
    if (aiScore == null || aiScore < minScore) {
      skipped.push({ symbol, reason: "below_minScore" });
      continue;
    }

    const entryPrice = getNum(s, ["entryPrice", "ai.entryPrice"]);
    const stopPrice = getNum(s, ["stopPrice", "ai.stopPrice"]);
    const targetPrice = getNum(s, ["targetPrice", "takeProfitPrice", "ai.targetPrice", "ai.takeProfitPrice"]);

    if (entryPrice == null || stopPrice == null || targetPrice == null) {
      skipped.push({ symbol, reason: "missing_required_prices" });
      continue;
    }

    const symbolSide = `${symbol}:${side}`;
    if (seenCandidateSymbolSide.has(symbolSide)) {
      skipped.push({ symbol, reason: "duplicate_symbol_side_in_batch" });
      continue;
    }
    seenCandidateSymbolSide.add(symbolSide);
    totalCandidates += 1;

    if (created.length >= limit) {
      skipped.push({ symbol, reason: "limit_reached" });
      continue;
    }

    const signalId = String(s.id || "");

    if (signalId && existingBySignalId.has(signalId)) {
      skipped.push({ symbol, reason: "already_has_trade_for_signal" });
      continue;
    }

    if (existingPendingBySymbolSide.has(symbolSide)) {
      skipped.push({ symbol, reason: "already_has_pending_for_symbol_side" });
      continue;
    }

    const tier = tierForScore(aiScore) || "C";
    if (tier === "C" && !cfg.allowedTiers.includes("C")) {
      skipped.push({ symbol, reason: "tier_c_disabled" });
      continue;
    }

    const now = new Date().toISOString();

    const trade = {
      id: crypto.randomUUID(),
      ticker: symbol,
      side,
      entryPrice,
      stopPrice,
      targetPrice,
      takeProfitPrice: targetPrice,
      status: "AUTO_PENDING",
      source: "AUTO",
      paper: true,
      createdAt: now,
      updatedAt: now,
      signalId,
      aiScore,
      tier,
      autoEntryStatus: "AUTO_PENDING",
    };

    await upsertTrade(trade);

    existingBySignalId.add(signalId);
    existingPendingBySymbolSide.add(symbolSide);
    created.push({
      id: trade.id,
      symbol,
      side,
      signalId,
      aiScore,
      tier,
    });
  }

  return NextResponse.json(
    {
      ok: true,
      today,
      limit,
      minScore,
      totalSignals: (signals || []).length,
      totalCandidates,
      createdCount: created.length,
      skippedCount: skipped.length,
      created,
      skipped: skipped.slice(0, 50),
    },
    { status: 200 }
  );
}
