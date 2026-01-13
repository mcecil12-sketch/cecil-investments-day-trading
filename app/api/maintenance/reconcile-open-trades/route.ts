import { NextResponse } from "next/server";
import { alpacaRequest } from "@/lib/alpaca";
import { readTrades, writeTrades } from "@/lib/tradesStore";

export const dynamic = "force-dynamic";

const up = (v: any) => String(v || "").toUpperCase();

export async function POST(req: Request) {
  const token = req.headers.get("x-cron-token") || "";
  if (!process.env.CRON_TOKEN || token !== process.env.CRON_TOKEN) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const dryRun = body?.dryRun === true;
  const max = Number.isFinite(body?.max) ? Math.max(1, Number(body.max)) : 500;
  const now = new Date().toISOString();
  const closeReason = String(body?.closeReason || "reconciled_not_in_alpaca");

  // Alpaca positions
  let positions: any[] = [];
  try {
    const r = await alpacaRequest({ method: "GET", path: "/v2/positions" });
    const parsed = JSON.parse(r.text || "[]");
    positions = Array.isArray(parsed) ? parsed : [];
  } catch {}
  const posSet = new Set(positions.map((p) => up(p?.symbol)).filter(Boolean));

  // Alpaca open orders
  let orders: any[] = [];
  try {
    const r = await alpacaRequest({ method: "GET", path: "/v2/orders?status=open&limit=500" });
    const parsed = JSON.parse(r.text || "[]");
    orders = Array.isArray(parsed) ? parsed : [];
  } catch {}
  const orderIdSet = new Set(orders.map((o) => String(o?.id || "")).filter(Boolean));
  const orderSymSet = new Set(orders.map((o) => up(o?.symbol)).filter(Boolean));

  // Trades (app state)
  const trades: any[] = await readTrades();
  const openTrades = trades.filter((t) => t?.status === "OPEN").slice(0, max);

  let closed = 0;
  const results: any[] = [];

  for (const t of openTrades) {
    const ticker = up(t?.ticker);
    const alpacaOrderId = String(t?.alpacaOrderId || "");

    const existsPos = ticker && posSet.has(ticker);
    const existsOrderId = alpacaOrderId && orderIdSet.has(alpacaOrderId);
    const existsOrderSym = ticker && orderSymSet.has(ticker);

    const stale = !existsPos && !existsOrderId && !existsOrderSym;

    if (!stale) {
      results.push({ id: t?.id, ticker, stale: false, existsPos, existsOrderId, existsOrderSym });
      continue;
    }

    if (!dryRun) {
      t.status = "CLOSED";
      t.closedAt = t.closedAt || now;
      t.closeReason = t.closeReason || closeReason;
      t.updatedAt = now;
      if (t.autoEntryStatus === "AUTO_PENDING") t.autoEntryStatus = "CLOSED";
    }

    closed += 1;
    results.push({ id: t?.id, ticker, stale: true, action: dryRun ? "would_close" : "closed" });
  }

  if (!dryRun && closed > 0) {
    await writeTrades(trades);
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    checked: openTrades.length,
    closed,
    alpaca: { positions: positions.length, openOrders: orders.length },
    results,
  });
}
