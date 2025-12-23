import { NextResponse } from "next/server";
import { submitOrder } from "@/lib/alpaca";
import { readTrades, writeTrades } from "@/lib/tradesStore";

export const runtime = "nodejs";

type Direction = "LONG" | "SHORT";

export type TradeStatus =
  | "NEW"
  | "BROKER_PENDING"
  | "BROKER_FILLED"
  | "BROKER_REJECTED"
  | "BROKER_ERROR";

export type ManagementStatus =
  | "UNMANAGED"
  | "STOP_MOVED_TO_BREAKEVEN"
  | "PARTIAL_TAKEN_1R"
  | "PARTIAL_TAKEN_2R"
  | "TRAILING"
  | "CLOSED";

export interface IncomingTrade {
  ticker: string;
  side: Direction; // LONG / SHORT
  quantity: number;

  entryPrice: number;
  stopPrice: number;
  targetPrice?: number;

  reasoning?: string;
  source?: string;

  submitToBroker?: boolean;
  orderType?: "market" | "limit";
  timeInForce?: "day" | "gtc";

  // optional automation flags
  autoManage?: boolean;
  manageSizePct1?: number;
  manageSizePct2?: number;
}

export interface TradeRecord extends IncomingTrade {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: TradeStatus;

  // Broker info
  brokerOrderId?: string;
  brokerStatus?: string;
  brokerRaw?: any;
  error?: string;

  // Auto-management info
  managementStatus?: ManagementStatus;
  lastAutoPrice?: number;
  lastAutoCheckAt?: string;

  // legacy/extended management config (kept for compatibility)
  management?: {
    enabled: boolean;
    tp1R: number;
    tp2R: number;
    tp1SizePct: number;
    tp2SizePct: number;
    tp1Done?: boolean;
    tp2Done?: boolean;
    movedToBE?: boolean;
    lastPrice?: number;
    lastUpdated?: string;
  };
}

function mapDirection(side: Direction): "buy" | "sell" {
  return side === "LONG" ? "buy" : "sell";
}

export async function GET() {
  try {
    const trades = await readTrades<TradeRecord>();
    return NextResponse.json({ trades });
  } catch (err: any) {
    console.error("[trades] GET error", err);
    return NextResponse.json(
      {
        ok: false,
        error: "Failed to load trades",
        detail: err?.message ?? String(err),
      },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as IncomingTrade;

    const now = new Date().toISOString();
    let status: TradeStatus = "NEW";
    let brokerOrder: any;
    let error: string | undefined;

    if (body.submitToBroker) {
      try {
        status = "BROKER_PENDING";

        brokerOrder = await submitOrder({
          symbol: body.ticker,
          qty: body.quantity,
          side: mapDirection(body.side),
          type: body.orderType ?? "market",
          timeInForce: body.timeInForce ?? "day",
        });

        status =
          brokerOrder.status === "filled" || brokerOrder.status === "partially_filled"
            ? "BROKER_FILLED"
            : "BROKER_PENDING";
      } catch (err: any) {
        status = "BROKER_ERROR";
        error = err.message;
      }
    }

    const newTrade: TradeRecord = {
      ...body,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      status,
      brokerOrderId: brokerOrder?.id,
      brokerStatus: brokerOrder?.status,
      brokerRaw: brokerOrder ? { id: brokerOrder.id, status: brokerOrder.status } : undefined,
      error,
      // Seed management fields for the auto-management engine
      managementStatus: "UNMANAGED",
      lastAutoPrice: body.entryPrice,
      lastAutoCheckAt: now,
      management: body.autoManage
        ? {
            enabled: true,
            tp1R: 1,
            tp2R: 2,
            tp1SizePct: body.manageSizePct1 ?? 0.5,
            tp2SizePct: body.manageSizePct2 ?? 1.0,
            tp1Done: false,
            tp2Done: false,
            movedToBE: false,
            lastUpdated: now,
          }
        : undefined,
    };

    const trades = await readTrades<TradeRecord>();
    await writeTrades([newTrade, ...trades]);

    return NextResponse.json({ ok: true, trade: newTrade }, { status: 201 });
  } catch (err: any) {
    console.error("[trades] POST error", err);
    return NextResponse.json(
      {
        ok: false,
        error: "Failed to create trade",
        detail: err?.message ?? String(err),
      },
      { status: 500 }
    );
  }
}
