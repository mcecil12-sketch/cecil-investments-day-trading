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
    if (!tradeId) {
      return NextResponse.json(
        { error: "tradeId is required" },
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
    if (!trade.alpacaOrderId) {
      return NextResponse.json(
        { error: "Trade has no alpacaOrderId" },
        { status: 400 }
      );
    }
    if (trade.suggestedStopPrice == null) {
      return NextResponse.json(
        { error: "No suggestedStopPrice for trade" },
        { status: 400 }
      );
    }

    console.log("[apply-stop] requested", {
      tradeId,
      ticker: trade.ticker,
      suggestedStopPrice: trade.suggestedStopPrice,
    });

    // Fetch parent order with legs
    const order = await getOrder(trade.alpacaOrderId);
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
    const newStop = trade.suggestedStopPrice;

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

    return NextResponse.json({ trade: updatedTrade }, { status: 200 });
  } catch (err) {
    console.error("POST /api/trades/apply-stop error:", err);
    return NextResponse.json(
      { error: "Failed to apply stop" },
      { status: 500 }
    );
  }
}
