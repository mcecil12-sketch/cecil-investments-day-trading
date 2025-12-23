import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getOrder, replaceOrder } from "@/lib/alpaca";
import { appendActivity } from "@/lib/activity";

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
  updatedAt?: string;
  lastStopAppliedAt?: string;
};

const TRADES_FILE = path.join(process.cwd(), "data", "trades.json");

async function readTrades(): Promise<Trade[]> {
  try {
    const raw = await fs.readFile(TRADES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Trade[]) : [];
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

async function writeTrades(trades: Trade[]): Promise<void> {
  await fs.writeFile(TRADES_FILE, JSON.stringify(trades, null, 2), "utf8");
}

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

    if (!stopLeg?.id) {
      console.error("[apply-stop] stop leg not found", {
        tradeId,
        alpacaOrderId: trade.alpacaOrderId,
      });
      return NextResponse.json(
        { error: "Stop leg not found in order" },
        { status: 500 }
      );
    }

    const oldStop = stopLeg.stop_price;
    const newStop = requestedStop;

    console.log("[apply-stop] replacing stop", {
      tradeId,
      ticker: trade.ticker,
      stopLegId: stopLeg.id,
      oldStop,
      newStop,
    });

    const replaced = await replaceOrder(stopLeg.id, {
      stop_price: newStop,
    });

    const nowIso = new Date().toISOString();
    const updatedTrade: Trade = {
      ...trade,
      stopPrice: newStop,
      suggestedStopPrice: undefined,
      stopSuggestionReason: undefined,
      updatedAt: nowIso,
      lastStopAppliedAt: nowIso,
      alpacaStatus: replaced.status ?? trade.alpacaStatus,
      alpacaOrderId: orderId,
    };

    trades[idx] = updatedTrade;
    await writeTrades(trades);

    await appendActivity({
      type: "MANUAL_STOP_APPLIED",
      tradeId,
      ticker: trade.ticker,
      message: `Stop moved ${oldStop} -> ${newStop}`,
      meta: { stopLegId: stopLeg.id },
    });

    console.log("[apply-stop] updated trade", {
      tradeId,
      alpacaOrderId: trade.alpacaOrderId,
      stopLegId: stopLeg.id,
    });

    return NextResponse.json(
      {
        ok: true,
        trade: updatedTrade,
        orderId,
        stopLegId: stopLeg.id,
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
