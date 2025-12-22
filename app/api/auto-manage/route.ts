import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getLatestQuote } from "@/lib/alpaca";

export const runtime = "nodejs";

const TRADES_PATH = path.join(process.cwd(), "data", "trades.json");

// ---- Types ------------------------------------------------------------

type Direction = "LONG" | "SHORT";

interface ManagedTrade {
  id: string;
  ticker: string;
  side: Direction;
  quantity: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice?: number;

  status?: string; // BROKER_* etc.

  // Auto-management fields
  managementStatus?: string; // UNMANAGED, PARTIAL_TAKEN_1R, PARTIAL_TAKEN_2R, TRAILING_STOP...
  lastAutoPrice?: number;
  lastAutoCheckAt?: string;

  // New fields for R-based management
  partial1Taken?: boolean;
  partial2Taken?: boolean;
  highWaterMark?: number; // best price seen since entry for trailing
}

// Shape of a single update record in the API response
interface ManagementUpdate {
  id: string;
  ticker: string;
  fromStatus: string;
  toStatus: string;
  prevStop: number;
  newStop: number;
  currentPrice: number;
  rMultiple: number;
  note?: string;
}

// ---- Configurable R rules --------------------------------------------

const AUTO_RULES = {
  // First partial at 1R
  partial1: {
    rTrigger: 1, // hit 1R
    fraction: 1 / 3, // conceptual – we’re not changing quantity yet, just bookkeeping
  },
  // Second partial at 2R
  partial2: {
    rTrigger: 2, // hit 2R
    fraction: 1 / 3,
  },
  trailing: {
    minRForTrailing: 2, // start trailing once at/above 2R
    trailR: 1, // keep stop 1R behind high watermark
  },
};

// Statuses that we consider "open" for auto-management
const OPEN_STATUSES = new Set([
  "NEW",
  "BROKER_PENDING",
  "BROKER_FILLED",
  "UNMANAGED",
  "STOP_MOVED_TO_BREAKEVEN",
  "PARTIAL_TAKEN_1R",
  "PARTIAL_TAKEN_2R",
  "TRAILING_STOP",
]);

// ---- File helpers -----------------------------------------------------

async function ensureTradesFile(): Promise<void> {
  try {
    await fs.access(TRADES_PATH);
  } catch {
    await fs.mkdir(path.dirname(TRADES_PATH), { recursive: true });
    await fs.writeFile(TRADES_PATH, "[]", "utf8");
  }
}

async function readTrades(): Promise<ManagedTrade[]> {
  await ensureTradesFile();
  const raw = await fs.readFile(TRADES_PATH, "utf8");
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as ManagedTrade[];
    if (Array.isArray(parsed.trades)) return parsed.trades as ManagedTrade[];
    return [];
  } catch (err) {
    console.error("[/api/auto-manage] Failed to parse trades.json:", err);
    return [];
  }
}

async function writeTrades(trades: ManagedTrade[]): Promise<void> {
  const data = JSON.stringify(trades, null, 2);
  await fs.writeFile(TRADES_PATH, data, "utf8");
}

// ---- R helpers --------------------------------------------------------

function computeRiskPerShare(trade: ManagedTrade): number {
  if (trade.side === "LONG") {
    return trade.entryPrice - trade.stopPrice;
  } else {
    // SHORT
    return trade.stopPrice - trade.entryPrice;
  }
}

function computeRMultiple(
  trade: ManagedTrade,
  currentPrice: number,
  riskPerShare: number
): number {
  if (riskPerShare <= 0) return 0;

  if (trade.side === "LONG") {
    return (currentPrice - trade.entryPrice) / riskPerShare;
  } else {
    // SHORT: profit as price moves down
    return (trade.entryPrice - currentPrice) / riskPerShare;
  }
}

// ---- Core management logic -------------------------------------------

async function manageTrade(
  trade: ManagedTrade
): Promise<{ trade: ManagedTrade; update?: ManagementUpdate }> {
  const symbol = trade.ticker;

  // Skip if quantity is 0 or trade isn't "open"
  if (!trade.quantity || trade.quantity <= 0) {
    return { trade };
  }
  const status = trade.managementStatus || trade.status || "UNMANAGED";
  if (!OPEN_STATUSES.has(status)) {
    return { trade };
  }

  // Get current market price from Alpaca
  let currentPrice: number;
  try {
    const quote = await getLatestQuote(symbol);
    // prefer mid-price if available, else last/ask/bid
    const q: any = quote as any;
    const last = q.lastPrice ?? q.lp ?? q.last ?? q.p ?? q.price;
    const ask = q.askPrice ?? q.ap;
    const bid = q.bidPrice ?? q.bp;
    const q: any = quote as any;
    const last = q.lastPrice ?? q.lp ?? q.last ?? q.p ?? q.price;
    const ask = q.askPrice ?? q.ap;
    const bid = q.bidPrice ?? q.bp;
    const mid =
      (last != null ? Number(last) : undefined) ??
      (ask != null && bid != null ? (Number(ask) + Number(bid)) / 2 : undefined) ??
      (ask != null ? Number(ask) : undefined) ??
      (bid != null ? Number(bid) : undefined);

    if (!mid || !isFinite(mid)) {
      console.warn("[/api/auto-manage] No usable price for", symbol, quote);
      return { trade };
    }
    currentPrice = mid;
  } catch (err) {
    console.error("[/api/auto-manage] Failed to fetch quote for", symbol, err);
    return { trade };
  }

  const riskPerShare = computeRiskPerShare(trade);
  if (riskPerShare <= 0) {
    console.warn(
      "[/api/auto-manage] Non-positive riskPerShare, skipping",
      trade.id
    );
    return { trade };
  }

  const rMultiple = computeRMultiple(trade, currentPrice, riskPerShare);

  let updated = false;
  const prevStop = trade.stopPrice;
  let newStop = trade.stopPrice;
  const fromStatus = status;
  let toStatus = status;
  let note = "";

  let partial1Taken = trade.partial1Taken ?? false;
  let partial2Taken = trade.partial2Taken ?? false;
  let highWaterMark =
    trade.highWaterMark ??
    trade.entryPrice; // start from entry if none

  // --- 1R logic: move stop to breakeven and mark partial1Taken ----
  if (rMultiple >= AUTO_RULES.partial1.rTrigger && !partial1Taken) {
    partial1Taken = true;
    // Move stop to breakeven (entry)
    const breakeven = trade.entryPrice;
    if (trade.side === "LONG") {
      newStop = Math.max(newStop, breakeven);
    } else {
      // SHORT: stop above price, so min
      newStop = Math.min(newStop, breakeven);
    }
    toStatus = "PARTIAL_TAKEN_1R";
    note = "Hit 1R: move stop to breakeven; partial1Taken=true";
    updated = true;
  }

  // --- 2R logic: move stop to +1R and mark partial2Taken ----------
  if (rMultiple >= AUTO_RULES.partial2.rTrigger && !partial2Taken) {
    partial2Taken = true;
    const oneRPriceOffset =
      trade.side === "LONG" ? riskPerShare : -riskPerShare;
    // Stop at entry + 1R
    const oneRStop =
      trade.entryPrice +
      (trade.side === "LONG" ? oneRPriceOffset : oneRPriceOffset);

    if (trade.side === "LONG") {
      newStop = Math.max(newStop, oneRStop);
    } else {
      // SHORT: stop lower, more favorable
      newStop = Math.min(newStop, oneRStop);
    }

    toStatus = "PARTIAL_TAKEN_2R";
    note = note
      ? note + " | Hit 2R: move stop to +1R; partial2Taken=true"
      : "Hit 2R: move stop to +1R; partial2Taken=true";
    updated = true;
  }

  // --- Trailing logic once above 2R -------------------------------
  if (rMultiple >= AUTO_RULES.trailing.minRForTrailing) {
    // Update high watermark
    if (trade.side === "LONG") {
      highWaterMark = Math.max(highWaterMark, currentPrice);
    } else {
      // For SHORT, "best" price is the lowest one
      highWaterMark = Math.min(highWaterMark, currentPrice);
    }

    const trailOffset =
      AUTO_RULES.trailing.trailR * riskPerShare; // 1R behind high-watermark
    let trailStopCandidate: number;
    if (trade.side === "LONG") {
      trailStopCandidate = highWaterMark - trailOffset;
      // never move stop down
      newStop = Math.max(newStop, trailStopCandidate);
    } else {
      // SHORT
      trailStopCandidate = highWaterMark + trailOffset;
      // never move stop up (less favorable)
      newStop = Math.min(newStop, trailStopCandidate);
    }

    if (!updated && newStop !== prevStop) {
      note = "Trailing: updated stop based on highWaterMark";
    } else if (newStop !== prevStop) {
      note = note
        ? note + " | Trailing: updated stop based on highWaterMark"
        : "Trailing: updated stop based on highWaterMark";
    }

    if (newStop !== prevStop) {
      toStatus = "TRAILING_STOP";
      updated = true;
    }
  }

  if (!updated) {
    // Still update lastAuto* fields so we know it was checked
    const noopTrade: ManagedTrade = {
      ...trade,
      lastAutoPrice: currentPrice,
      lastAutoCheckAt: new Date().toISOString(),
      highWaterMark,
      partial1Taken,
      partial2Taken,
      managementStatus: fromStatus,
    };
    return { trade: noopTrade };
  }

  const updatedTrade: ManagedTrade = {
    ...trade,
    stopPrice: newStop,
    lastAutoPrice: currentPrice,
    lastAutoCheckAt: new Date().toISOString(),
    highWaterMark,
    partial1Taken,
    partial2Taken,
    managementStatus: toStatus,
  };

  const update: ManagementUpdate = {
    id: trade.id,
    ticker: trade.ticker,
    fromStatus,
    toStatus,
    prevStop,
    newStop,
    currentPrice,
    rMultiple,
    note,
  };

  return { trade: updatedTrade, update };
}

// ---- GET handler ------------------------------------------------------

export async function GET() {
  try {
    const trades = await readTrades();
    const updates: ManagementUpdate[] = [];
    const nextTrades: ManagedTrade[] = [];

    for (const trade of trades) {
      const { trade: updatedTrade, update } = await manageTrade(trade);
      nextTrades.push(updatedTrade);
      if (update) {
        updates.push(update);
      }
    }

    if (updates.length > 0) {
      await writeTrades(nextTrades);
    }

    return NextResponse.json(
      {
        checked: trades.length,
        updated: updates.length,
        updates,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("[/api/auto-manage] GET error:", err);
    return NextResponse.json(
      { error: "Failed to auto-manage trades." },
      { status: 500 }
    );
  }
}
