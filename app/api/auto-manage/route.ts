import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import {
  runAutoManagement,
  SourceTrade,
} from "@/lib/tradeEngine";

const TRADES_FILE = path.join(process.cwd(), "data", "trades.json");

async function readTradesFile(): Promise<SourceTrade[]> {
  try {
    const raw = await fs.readFile(TRADES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed as SourceTrade[];
    }
    return [];
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return [];
    }
    console.error("[auto-manage] Error reading trades file:", err);
    throw err;
  }
}

export async function GET() {
  try {
    const trades = await readTradesFile();
    const { trades: engineTrades, summary } = await runAutoManagement(trades);

    return NextResponse.json(
      {
        ok: true,
        trades: engineTrades,
        summary,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("[auto-manage] GET error:", err);
    return NextResponse.json(
      {
        ok: false,
        error: err?.message || "Failed to run auto-management",
      },
      { status: 500 }
    );
  }
}
