import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { alpacaRequest } from "@/lib/alpaca";
import { readTrades, writeTrades } from "@/lib/tradesStore";

export const dynamic = "force-dynamic";

const POSITION_OPEN_OVERRIDES_CANCELED_v1 = true;

const up = (v: any) => String(v || "").toUpperCase();

async function safeJsonArray(text: string | undefined): Promise<any[]> {
  try {
    const parsed = JSON.parse(text || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function safeJsonObject(text: string | undefined): Promise<any | null> {
  try {
    const parsed = JSON.parse(text || "null");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const token = req.headers.get("x-cron-token") || "";
  const cookieStore = await cookies();
  const sessionAuth = cookieStore.get("session")?.value;

  if (sessionAuth) {
    return NextResponse.json({ ok: true, authMode: 'session' }, { status: 200 });
  }

  if (!process.env.CRON_TOKEN || token !== process.env.CRON_TOKEN) {
    return NextResponse.json({ ok: false, error: "unauthorized", authMode: null }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const dryRun = body?.dryRun === true;
  const max = Number.isFinite(body?.max) ? Math.max(1, Number(body.max)) : 500;

  const nowIso = new Date().toISOString();
  const closeReason = String(body?.closeReason || "reconciled_not_in_alpaca");

  const syncToPositionOpen = body?.syncToPositionOpen !== false;

  let positions: any[] = [];
  try {
    const r = await alpacaRequest({ method: "GET", path: "/v2/positions" });
    positions = await safeJsonArray(r.text);
  } catch {}

  const posBySym = new Map<string, any>();
  for (const p of positions) {
    const sym = up(p?.symbol);
    if (sym) posBySym.set(sym, p);
  }

  let ordersOpen: any[] = [];
  try {
    const r = await alpacaRequest({ method: "GET", path: "/v2/orders?status=open&limit=500" });
    ordersOpen = await safeJsonArray(r.text);
  } catch {}

  const openOrderIdSet = new Set(ordersOpen.map((o) => String(o?.id || "")).filter(Boolean));
  const openOrderSymSet = new Set(ordersOpen.map((o) => up(o?.symbol)).filter(Boolean));

  const trades: any[] = await readTrades();
  const openTrades = trades.filter((t) => (t?.status || "").toUpperCase() === "OPEN").slice(0, max);

  let closed = 0;
  let synced = 0;

  const results: any[] = [];

  for (const t of openTrades) {
    const ticker = up(t?.ticker);
    const existsPos = Boolean(ticker && posBySym.has(ticker));

    const alpacaOrderId = String(t?.alpacaOrderId || t?.brokerOrderId || "");
    const existsOrderId = Boolean(alpacaOrderId && openOrderIdSet.has(alpacaOrderId));
    const existsOrderSym = Boolean(ticker && openOrderSymSet.has(ticker));

    const stale = !existsPos && !existsOrderId && !existsOrderSym;

    if (stale) {
      if (!dryRun) {
        t.status = "CLOSED";
        t.closedAt = t.closedAt || nowIso;
        t.updatedAt = nowIso;
        t.closeReason = closeReason;
        t.autoEntryStatus = "CLOSED";
        t.alpacaStatus = t.alpacaStatus || "not_found";
        t.brokerStatus = t.brokerStatus || "not_found";
      }
      closed += 1;
      results.push({ id: t?.id, ticker, stale: true, action: dryRun ? "would_close" : "closed" });
      continue;
    }

    if (syncToPositionOpen && existsPos) {
      let orderStatus: string | null = null;

      if (alpacaOrderId) {
        try {
          const r = await alpacaRequest({ method: "GET", path: `/v2/orders/${encodeURIComponent(alpacaOrderId)}` });
          const obj = await safeJsonObject(r.text);
          const s = obj?.status ? String(obj.status) : null;
          if (s) orderStatus = s;

            if (existsPos && orderStatus) {
              const os = String(orderStatus).toLowerCase();
              if (os === "canceled" || os === "expired" || os === "rejected") {
                orderStatus = "position_open";
              }
            }

          if (!dryRun && obj && (typeof obj.filled_qty === "string" || typeof obj.filled_qty === "number")) {
            const fq = Number(obj.filled_qty);
            if (Number.isFinite(fq) && fq > 0) t.filledQty = fq;
          }
          if (!dryRun && obj && (typeof obj.filled_avg_price === "string" || typeof obj.filled_avg_price === "number")) {
            const ap = Number(obj.filled_avg_price);
            if (Number.isFinite(ap) && ap > 0) t.avgFillPrice = ap;
          }
        } catch {}
      }

      if (!dryRun) {
        t.autoEntryStatus = "OPEN";
        t.alpacaStatus = orderStatus || "position_open";
        t.brokerStatus = orderStatus || "position_open";
        t.updatedAt = nowIso;

        if ((t.filledQty == null || !Number.isFinite(Number(t.filledQty))) && Number.isFinite(Number(t.qty))) {
          t.filledQty = Number(t.qty);
        }

        if ((t.avgFillPrice == null || !Number.isFinite(Number(t.avgFillPrice))) && Number.isFinite(Number(t.entryPrice))) {
          t.avgFillPrice = Number(t.entryPrice);
        }
      }

      synced += 1;
      results.push({
        id: t?.id,
        ticker,
        stale: false,
        existsPos: true,
        existsOrderId,
        existsOrderSym,
        sync: dryRun ? "would_sync" : "synced",
        orderStatus: orderStatus || null,
      });
      continue;
    }

    results.push({ id: t?.id, ticker, stale: false, existsPos, existsOrderId, existsOrderSym });
  }

  if (!dryRun && (closed > 0 || synced > 0)) {
    await writeTrades(trades);
  }

  return NextResponse.json(
    {
      ok: true,
      dryRun,
      checked: openTrades.length,
      closed,
      synced,
      alpaca: { positions: positions.length, openOrders: ordersOpen.length },
      results,
    },
    { status: 200 }
  );
}
