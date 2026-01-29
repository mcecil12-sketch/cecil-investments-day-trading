import { NextResponse } from "next/server";
import { alpacaRequest } from "@/lib/alpaca";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import { fetchBrokerTruth } from "@/lib/broker/truth";

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

  const hasSession = req.headers.get("cookie")?.includes("session=") ?? false;
  const hasToken = !!process.env.CRON_TOKEN && token === process.env.CRON_TOKEN;

  if (!hasSession && !hasToken) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const dryRun = body?.dryRun === true;
  const max = Number.isFinite(body?.max) ? Math.max(1, Number(body.max)) : 500;

  const nowIso = new Date().toISOString();
  const closeReason = String(body?.closeReason || "reconciled_not_in_alpaca");
  const syncToPositionOpen = body?.syncToPositionOpen !== false;

  // Use broker-truth as authoritative source
  const brokerTruth = await fetchBrokerTruth();
  
  if (brokerTruth.error) {
    return NextResponse.json(
      {
        ok: false,
        error: "broker_truth_failed",
        detail: brokerTruth.error,
        message: "Cannot reconcile without broker truth",
      },
      { status: 500 }
    );
  }

  const posBySym = new Map<string, any>();
  for (const p of brokerTruth.positions) {
    const sym = up(p.symbol);
    if (sym) posBySym.set(sym, p);
  }

  const openOrderIdSet = new Set(
    brokerTruth.openOrders.map((o) => String(o.id || "")).filter(Boolean)
  );
  const openOrderSymSet = new Set(
    brokerTruth.openOrders.map((o) => up(o.symbol)).filter(Boolean)
  );

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
        t.alpacaStatus = t.alpacaStatus || "not_found_in_broker";
        t.brokerStatus = t.brokerStatus || "not_found_in_broker";
      }
      closed += 1;
      results.push({
        id: t?.id,
        ticker,
        stale: true,
        action: dryRun ? "would_close" : "closed",
        reason: "not_in_broker_positions_or_orders",
      });
      console.log(
        "[reconcile] closing stale trade",
        { id: t?.id, ticker, alpacaOrderId }
      );
      continue;
    }

    if (syncToPositionOpen && existsPos) {
      let orderStatus: string | null = null;

      if (alpacaOrderId) {
        try {
          const r = await alpacaRequest({
            method: "GET",
            path: `/v2/orders/${encodeURIComponent(alpacaOrderId)}`,
          });
          const obj = await safeJsonObject(r.text);
          const s = obj?.status ? String(obj.status) : null;
          if (s) orderStatus = s;

          if (
            existsPos &&
            orderStatus
          ) {
            const os = String(orderStatus).toLowerCase();
            if (
              os === "canceled" ||
              os === "expired" ||
              os === "rejected"
            ) {
              orderStatus = "position_open";
            }
          }

          if (
            !dryRun &&
            obj &&
            (typeof obj.filled_qty === "string" ||
              typeof obj.filled_qty === "number")
          ) {
            const fq = Number(obj.filled_qty);
            if (Number.isFinite(fq) && fq > 0) t.filledQty = fq;
          }
          if (
            !dryRun &&
            obj &&
            (typeof obj.filled_avg_price === "string" ||
              typeof obj.filled_avg_price === "number")
          ) {
            const ap = Number(obj.filled_avg_price);
            if (Number.isFinite(ap) && ap > 0) t.avgFillPrice = ap;
          }
        } catch (err) {
          console.warn(
            "[reconcile] order lookup failed",
            { alpacaOrderId, error: String(err) }
          );
        }
      }

      if (!dryRun) {
        t.autoEntryStatus = "OPEN";
        t.alpacaStatus = orderStatus || "position_open";
        t.brokerStatus = orderStatus || "position_open";
        t.updatedAt = nowIso;

        if (
          (t.filledQty == null ||
            !Number.isFinite(Number(t.filledQty))) &&
          Number.isFinite(Number(t.qty))
        ) {
          t.filledQty = Number(t.qty);
        }

        if (
          (t.avgFillPrice == null ||
            !Number.isFinite(Number(t.avgFillPrice))) &&
          Number.isFinite(Number(t.entryPrice))
        ) {
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

    results.push({
      id: t?.id,
      ticker,
      stale: false,
      existsPos,
      existsOrderId,
      existsOrderSym,
    });
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
      broker: {
        positionsCount: brokerTruth.positionsCount,
        openOrdersCount: brokerTruth.openOrdersCount,
        fetchedAt: brokerTruth.fetchedAt,
      },
      results,
    },
    { status: 200 }
  );
}
