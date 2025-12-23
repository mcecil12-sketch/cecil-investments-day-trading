import { NextResponse } from "next/server";
import { getOrder, replaceOrder, createOrder, type AlpacaOrder } from "@/lib/alpaca";
import { appendActivity } from "@/lib/activity";
import { readTrades, writeTrades } from "@/lib/tradesStore";

type TradeStatus = "OPEN" | "CLOSED" | "PENDING" | "PARTIAL" | string;

type Trade = {
  id: string;
  ticker: string;
  side: string;
  size: number;
  status: TradeStatus;
  entryPrice: number;
  stopPrice?: number;
  suggestedStopPrice?: number;
  stopSuggestionReason?: string;
  alpacaOrderId?: string;
  alpacaStatus?: string;
  brokerOrderId?: string;
  stopOrderId?: string;
  updatedAt?: string;
  lastStopAppliedAt?: string;
};

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
    const idx = trades.findIndex((t) => t.id === tradeId);
    if (idx === -1) {
      return NextResponse.json(
        { error: "Trade not found" },
        { status: 404 }
      );
    }

    const trade = trades[idx];
    const orderId = trade.brokerOrderId ?? trade.alpacaOrderId ?? null;
    if (!orderId) {
      return NextResponse.json(
        {
          ok: false,
          error: "Trade has no broker order id",
          tradeId,
          fields: {
            alpacaOrderId: trade.alpacaOrderId ?? null,
            brokerOrderId: trade.brokerOrderId ?? null,
          },
        },
        { status: 400 }
      );
    }

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

    console.log("[apply-stop] requested", {
      tradeId,
      ticker: trade.ticker,
      suggestedStopPrice: trade.suggestedStopPrice,
    });

    // Fetch parent order with legs
    const order = await getOrder(orderId);
    const legs = order.legs || [];
    const stopLeg = (legs as any[]).find(
      (leg: any) =>
        leg &&
        typeof leg.stop_price !== "undefined" &&
        leg.side &&
        leg.side.toLowerCase() !== order.side?.toLowerCase()
    );

    const oldStop = stopLeg?.stop_price;
    const newStop = requestedStop;

    console.log("[apply-stop] replacing stop", {
      tradeId,
      ticker: trade.ticker,
      stopLegId: stopLeg?.id,
      stopOrderId: trade.stopOrderId ?? null,
      oldStop,
      newStop,
    });

    let replaced: AlpacaOrder;
    let stopLegId: string | null = stopLeg?.id ?? null;
    let stopOrderIdUsed: string | null = null;

    if (stopLeg?.id) {
      replaced = await replaceOrder(stopLeg.id, {
        stop_price: newStop,
      });
    } else {
      const qty = (trade as any).quantity ?? trade.size;
      if (!qty) {
        return NextResponse.json(
          {
            ok: false,
            error: "Missing trade quantity/size",
            tradeId,
            fields: {
              quantity: (trade as any).quantity ?? null,
              size: trade.size ?? null,
            },
          },
          { status: 400 }
        );
      }
      const stopSide = trade.side === "LONG" ? "sell" : "buy";
      if (trade.stopOrderId) {
        replaced = await replaceOrder(trade.stopOrderId, {
          stop_price: newStop,
        });
        stopOrderIdUsed = trade.stopOrderId;
      } else {
        const created = await createOrder({
          symbol: trade.ticker.toUpperCase(),
          qty,
          side: stopSide,
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
      alpacaStatus: replaced.status ?? trade.alpacaStatus,
      alpacaOrderId: trade.alpacaOrderId ?? orderId,
      stopOrderId: trade.stopOrderId,
    };

    trades[idx] = updatedTrade;
    await writeTrades(trades);

    await appendActivity({
      type: "MANUAL_STOP_APPLIED",
      tradeId,
      ticker: trade.ticker,
      message: `Stop moved ${oldStop} -> ${newStop}`,
      meta: { stopLegId: stopLeg?.id ?? null, stopOrderId: stopOrderIdUsed },
    });

    console.log("[apply-stop] updated trade", {
      tradeId,
      alpacaOrderId: trade.alpacaOrderId,
      stopLegId,
      stopOrderId: stopOrderIdUsed,
    });

    return NextResponse.json(
      {
        ok: true,
        trade: updatedTrade,
        orderId,
        stopLegId,
        stopOrderId: stopOrderIdUsed,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("POST /api/trades/apply-stop error:", err);
    return NextResponse.json(
      { ok: false, error: "Failed to apply stop" },
      { status: 500 }
    );
  }
}
