/**
 * POST /api/maintenance/recompute-pnl
 *
 * Recomputes realizedPnL and realizedR for CLOSED trades using actual Alpaca fill
 * activities keyed by order ID, replacing any values that were computed using assumed
 * stop/target prices. Auth: x-cron-token header.
 *
 * Query params:
 *   tickers  — comma-separated list of tickers to restrict recompute (optional)
 *   limit    — max trades to process (default 50, max 100)
 */

import { NextResponse } from "next/server";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import { alpacaRequest } from "@/lib/alpaca";

export const dynamic = "force-dynamic";

function isAuthed(req: Request): boolean {
  const tok = req.headers.get("x-cron-token") || "";
  return Boolean(process.env.CRON_TOKEN && tok && tok === process.env.CRON_TOKEN);
}

function toNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function aggregateFillSide(
  activities: any[],
  side: "buy" | "sell",
): { avgPrice: number | null; qty: number } {
  let notional = 0;
  let qty = 0;
  for (const a of Array.isArray(activities) ? activities : []) {
    if (String(a?.side || "").toLowerCase() !== side) continue;
    const px = Number(a?.price);
    const q = Math.abs(Number(a?.qty));
    if (!Number.isFinite(px) || px <= 0 || !Number.isFinite(q) || q <= 0) continue;
    notional += px * q;
    qty += q;
  }
  return { avgPrice: qty > 0 ? notional / qty : null, qty };
}

async function fetchFillsByOrderIds(orderIds: string[]): Promise<any[]> {
  const seen = new Set<string>();
  const allFills: any[] = [];
  for (const orderId of orderIds) {
    if (!orderId || seen.has(orderId)) continue;
    seen.add(orderId);
    try {
      const qs = new URLSearchParams({
        activity_types: "FILL",
        order_id: orderId,
        page_size: "100",
        direction: "desc",
      });
      const resp = await alpacaRequest({ method: "GET", path: `/v2/account/activities?${qs}` });
      if (!resp.ok) continue;
      const arr = JSON.parse(resp.text || "[]");
      if (Array.isArray(arr)) allFills.push(...arr);
    } catch {
      // non-fatal — skip this order's fills
    }
  }
  return allFills;
}

function resolveRiskStop(t: any): number | null {
  for (const field of ["originalStopPrice", "initialStopPrice", "seedStopPrice", "stopPrice"]) {
    const n = Number(t[field]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

interface RecomputeResult {
  realizedPnL: number;
  realizedR?: number;
  avgEntry: number;
  avgExit: number;
}

function computeFromFills(args: {
  side: string;
  stopPrice: number | null;
  activities: any[];
  fallbackEntryPrice: number | null;
  fallbackExitPrice: number | null;
  fallbackQty: number | null;
}): RecomputeResult | null {
  const side = String(args.side || "LONG").toUpperCase();
  const entrySide: "buy" | "sell" = side === "SHORT" ? "sell" : "buy";
  const exitSide: "buy" | "sell" = side === "SHORT" ? "buy" : "sell";

  const entryAgg = aggregateFillSide(args.activities, entrySide);
  const exitAgg = aggregateFillSide(args.activities, exitSide);

  const avgEntry = entryAgg.avgPrice ?? args.fallbackEntryPrice;
  const avgExit = exitAgg.avgPrice ?? args.fallbackExitPrice;
  const fallbackQty = Math.abs(Number(args.fallbackQty) || 0);
  const matchedQty = Math.min(
    entryAgg.qty > 0 ? entryAgg.qty : fallbackQty,
    exitAgg.qty > 0 ? exitAgg.qty : fallbackQty,
  );

  if (!(avgEntry != null && avgEntry > 0 && avgExit != null && avgExit > 0 && matchedQty > 0)) {
    return null;
  }

  const pnlPerShare = side === "SHORT" ? avgEntry - avgExit : avgExit - avgEntry;
  const realizedPnL = Number((pnlPerShare * matchedQty).toFixed(2));

  const stop = args.stopPrice;
  if (!(stop != null && stop > 0)) {
    return { realizedPnL, avgEntry, avgExit };
  }

  const riskPerShare = side === "SHORT" ? stop - avgEntry : avgEntry - stop;
  if (!(riskPerShare > 0)) {
    return { realizedPnL, avgEntry, avgExit };
  }

  const realizedR = Number((pnlPerShare / riskPerShare).toFixed(4));
  return { realizedPnL, realizedR, avgEntry, avgExit };
}

export async function POST(req: Request) {
  if (!isAuthed(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const tickers = (url.searchParams.get("tickers") || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const rawLimit = Number(url.searchParams.get("limit") || "50");
  const effectiveLimit = Math.min(100, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 50));

  const trades = await readTrades<any>();

  const candidates = trades
    .filter((t: any) => {
      if (String(t.status || "").toUpperCase() !== "CLOSED") return false;
      if (tickers.length && !tickers.includes(String(t.ticker || "").toUpperCase())) return false;
      return true;
    })
    .sort((a: any, b: any) => String(b.closedAt || "").localeCompare(String(a.closedAt || "")))
    .slice(0, effectiveLimit);

  let recomputedCount = 0;
  let skippedCount = 0;
  let anomalyCount = 0;
  const results: any[] = [];

  for (const t of candidates) {
    const ticker = String(t.ticker || "").toUpperCase();
    const tradeId = String(t.id || "");

    const orderIds = Array.from(
      new Set(
        [
          String(t.brokerOrderId || t.alpacaOrderId || ""),
          String(t.stopOrderId || ""),
          String(t.takeProfitOrderId || ""),
        ].filter(Boolean),
      ),
    );

    if (!orderIds.length) {
      skippedCount++;
      results.push({ tradeId, ticker, action: "skipped", reason: "no_order_ids" });
      continue;
    }

    const activities = await fetchFillsByOrderIds(orderIds);
    const stopPx = resolveRiskStop(t);

    const computed = computeFromFills({
      side: t.side || "LONG",
      stopPrice: stopPx,
      activities,
      fallbackEntryPrice: toNum(t.entryFillPrice ?? t.avgFillPrice ?? t.entryPrice),
      fallbackExitPrice: toNum(t.exitFillPrice ?? t.closePrice),
      fallbackQty: toNum(t.filledQty ?? t.qty ?? t.quantity ?? t.size),
    });

    if (!computed) {
      skippedCount++;
      results.push({ tradeId, ticker, action: "skipped", reason: "insufficient_fill_data" });
      continue;
    }

    const { realizedPnL, realizedR, avgEntry, avgExit } = computed;
    const isAnomaly = typeof realizedR === "number" && Math.abs(realizedR) > 3;

    if (isAnomaly) {
      anomalyCount++;
      console.error("[recompute-pnl] R_ANOMALY detected after recompute", {
        tradeId,
        ticker,
        realizedR,
        avgEntry,
        avgExit,
        stopPx,
      });
    }

    const idx = trades.findIndex((x: any) => x.id === t.id);
    if (idx >= 0) {
      if (typeof avgEntry === "number") trades[idx].entryFillPrice = avgEntry;
      if (typeof avgExit === "number") trades[idx].exitFillPrice = avgExit;
      trades[idx].realizedPnL = realizedPnL;
      if (typeof realizedR === "number") trades[idx].realizedR = realizedR;
      trades[idx].updatedAt = new Date().toISOString();
    }

    recomputedCount++;
    results.push({
      tradeId,
      ticker,
      action: "recomputed",
      realizedPnL,
      realizedR: realizedR ?? null,
      avgEntry,
      avgExit,
      isAnomaly,
    });
  }

  if (recomputedCount > 0) {
    await writeTrades(trades);
  }

  return NextResponse.json({
    ok: true,
    recomputedCount,
    skippedCount,
    anomalyCount,
    results,
  });
}
