import { NextResponse } from "next/server";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import { promises as fs } from "fs";
import path from "path";
import {
  getOrder,
  replaceOrder,
  createOrder,
  type AlpacaOrder,
} from "@/lib/alpaca";
import { appendActivity } from "@/lib/activity";

type TradeStatus = "OPEN" | "CLOSED" | "PENDING" | "PARTIAL" | string;

type Trade = {
  id: string;
  ticker: string;
  side: string;
  size?: number;
  quantity?: number;
  status: TradeStatus;
  entryPrice: number;
  stopPrice?: number;
  suggestedStopPrice?: number;
  stopSuggestionReason?: string;
  alpacaOrderId?: string | null;
  alpacaStatus?: string | null;
  brokerOrderId?: string | null;
  stopOrderId?: string | null;
  updatedAt?: string;
  lastStopAppliedAt?: string | null;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null);
    const tradeId = body?.tradeId as string | undefined;
    const bodyStopPrice = body?.stopPrice;

    if (!tradeId) {
      return NextResponse.json(
        { ok: false, error: "tradeId is required" },
        { status: 400 }
      );
    }

    const trades = await readTrades();
    const idx = trades.findIndex((t) => t?.id === tradeId);
    if (idx === -1) {
      return NextResponse.json(
        { ok: false, error: "Trade not found", tradeId, totalTrades: trades.length },
        { status: 404 }
      );
    }

    const trade = trades[idx];

    const requestedStop =
      typeof bodyStopPrice === "number" && Number.isFinite(bodyStopPrice)
        ? bodyStopPrice
        : trade.suggestedStopPrice;

    if (requestedStop == null || !Number.isFinite(requestedStop)) {
      return NextResponse.json(
        {
          ok: false,
          error: "No stop price provided",
          tradeId,
          fields: {
            stopPrice: trade.stopPrice ?? null,
            suggestedStopPrice: trade.suggestedStopPrice ?? null,
          },
        },
        { status: 400 }
      );
    }

    const qty = Number((trade as any).quantity ?? trade.size ?? 0);
    if (!Number.isFinite(qty) || qty <= 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "Missing trade quantity/size",
          tradeId,
          fields: {
            quantity: (trade as any).quantity ?? null,
            size: (trade as any).size ?? null,
          },
        },
        { status: 400 }
      );
    }

    const stopSide = String(trade.side).toUpperCase() === "LONG" ? "sell" : "buy";
    const newStop = requestedStop;

    const orderId = (trade.brokerOrderId ?? trade.alpacaOrderId ?? null) as string | null;

    let replaced: AlpacaOrder;
    let stopLegId: string | null = null;
    let stopOrderIdUsed: string | null = null;
    let oldStop: any = null;

    if (orderId) {
      const order: any = await getOrder(orderId);
      const legs = order?.legs || [];
      const stopLeg = (legs as any[]).find(
        (leg: any) =>
          leg &&
          typeof leg.stop_price !== "undefined" &&
          leg.side &&
          leg.side.toLowerCase() !== String(order?.side ?? "").toLowerCase()
      );

      stopLegId = stopLeg?.id ?? null;
      oldStop = stopLeg?.stop_price ?? null;

      if (stopLeg?.id) {
        replaced = await replaceOrder(stopLeg.id, { stop_price: newStop });
      } else if (trade.stopOrderId) {
        replaced = await replaceOrder(trade.stopOrderId, { stop_price: newStop });
        stopOrderIdUsed = trade.stopOrderId;
      } else {
        const created = await createOrder({
          symbol: trade.ticker.toUpperCase(),
          qty,
          side: stopSide as any,
          type: "stop",
          time_in_force: "day",
          stop_price: newStop,
        });
        stopOrderIdUsed = created.id;
        trade.stopOrderId = stopOrderIdUsed;
        replaced = created as any;
      }

      trade.alpacaOrderId = trade.alpacaOrderId ?? orderId;
    } else {
      if (trade.stopOrderId) {
        replaced = await replaceOrder(trade.stopOrderId, { stop_price: newStop });
        stopOrderIdUsed = trade.stopOrderId;
      } else {
        const created = await createOrder({
          symbol: trade.ticker.toUpperCase(),
          qty,
          side: stopSide as any,
          type: "stop",
          time_in_force: "day",
          stop_price: newStop,
        });
        stopOrderIdUsed = created.id;
        trade.stopOrderId = stopOrderIdUsed;
        replaced = created as any;
      }
    }

    const nowIso = new Date().toISOString();
    const updatedTrade: Trade = {
      ...trade,
      stopPrice: newStop,
      suggestedStopPrice: undefined,
      stopSuggestionReason: undefined,
      updatedAt: nowIso,
      lastStopAppliedAt: nowIso,
      alpacaStatus: (replaced as any)?.status ?? trade.alpacaStatus ?? null,
      brokerOrderId: trade.brokerOrderId ?? null,
      alpacaOrderId: trade.alpacaOrderId ?? null,
      stopOrderId: trade.stopOrderId ?? null,
    };

    trades[idx] = updatedTrade;
    await writeTrades(trades);

    await appendActivity({
      type: "MANUAL_STOP_APPLIED",
      tradeId,
      ticker: trade.ticker,
      message: `Stop moved ${oldStop ?? "n/a"} -> ${newStop}`,
      meta: { stopLegId, stopOrderId: stopOrderIdUsed },
    });

    return NextResponse.json(
      {
        ok: true,
        trade: updatedTrade,
        orderId: orderId ?? null,
        stopLegId,
        stopOrderId: stopOrderIdUsed ?? updatedTrade.stopOrderId ?? null,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("POST /api/trades/apply-stop error:", err);
    return NextResponse.json({ ok: false, error: "Failed to apply stop" }, { status: 500 });
  }
}
