import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { submitOrder } from "@/lib/alpaca";

export const runtime = "nodejs";

const TRADES_PATH = path.join(process.cwd(), "data", "trades.json");

type Direction = "LONG" | "SHORT";

export interface IncomingTrade {
  ticker: string;
  side: Direction;
  quantity: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice?: number;
  reasoning?: string;
  source?: string;
  submitToBroker?: boolean;
  orderType?: "market" | "limit";
  timeInForce?: "day" | "gtc";
}

export interface TradeRecord extends IncomingTrade {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  brokerOrderId?: string;
  brokerStatus?: string;
  brokerRaw?: any;
  error?: string;
}

async function ensureFile() {
  try {
    await fs.access(TRADES_PATH);
  } catch {
    await fs.mkdir(path.dirname(TRADES_PATH), { recursive: true });
    await fs.writeFile(TRADES_PATH, "[]", "utf8");
  }
}

async function readTrades(): Promise<TradeRecord[]> {
  await ensureFile();
  const raw = await fs.readFile(TRADES_PATH, "utf8");
  if (!raw.trim()) return [];
  try {
    const json = JSON.parse(raw);
    return Array.isArray(json) ? json : json.trades ?? [];
  } catch {
    return [];
  }
}

async function writeTrades(trades: TradeRecord[]) {
  await fs.writeFile(TRADES_PATH, JSON.stringify(trades, null, 2), "utf8");
}

function mapDirection(side: Direction): "buy" | "sell" {
  return side === "LONG" ? "buy" : "sell";
}

export async function GET() {
  const trades = await readTrades();
  return NextResponse.json({ trades });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as IncomingTrade;

    const now = new Date().toISOString();
    let status = "NEW";
    let broker: any;
    let error: string | undefined;

    if (body.submitToBroker) {
      try {
        status = "BROKER_PENDING";

        broker = await submitOrder({
          symbol: body.ticker,
          qty: body.quantity,
          side: mapDirection(body.side),
          type: body.orderType ?? "market",
          timeInForce: body.timeInForce ?? "day",
        });

        status =
          broker.status === "filled" || broker.status === "partially_filled"
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
      brokerOrderId: broker?.id,
      brokerStatus: broker?.status,
      brokerRaw: broker,
      error,
    };

    const trades = await readTrades();
    await writeTrades([newTrade, ...trades]);

    return NextResponse.json({ trade: newTrade }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: "Failed to create trade" }, { status: 500 });
  }
}
