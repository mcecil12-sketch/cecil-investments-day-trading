import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { submitOrder } from "@/lib/alpaca";
import { getLatestQuote } from "@/lib/alpaca";
import type { TradeRecord } from "@/app/api/trades/route";

export const runtime = "nodejs";

const TRADES_PATH = path.join(process.cwd(), "data", "trades.json");
const AUTO_TRADE_ENABLED =
  process.env.AUTO_TRADE_ENABLED === "true";

/**
 * Basic shape of what we're expecting in trades.json.
 * This is intentionally minimal and tolerant of extra fields.
 */
type Direction = "LONG" | "SHORT";

interface TradeRecordShape {
  id: string;
  ticker: string;
  side: Direction;
  quantity: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice?: number;
  status?: string;
  managementStage?: "NONE" | "ONE_R_TAKEN" | "TWO_R_TAKEN" | "CLOSED";
}

interface AutoManageRequest {
  dryRun?: boolean;
}

type AutoSuggestionType =
  | "HOLD"
  | "TAKE_PARTIAL_1R"
  | "TAKE_PARTIAL_2R"
  | "STOP_OUT";

interface AutoManageAction {
  tradeId: string;
  ticker: string;
  side: Direction;
  quantity: number;
  currentPrice: number;
  currentR: number;
  suggestion: AutoSuggestionType;
  reason: string;
  qtyToExecute?: number;
  executed?: boolean;
  error?: string;
}

async function ensureTradesFile() {
  try {
    await fs.access(TRADES_PATH);
  } catch {
    await fs.mkdir(path.dirname(TRADES_PATH), { recursive: true });
    await fs.writeFile(TRADES_PATH, "[]", "utf8");
  }
}

async function readTrades(): Promise<TradeRecord[]> {
  await ensureTradesFile();
  const raw = await fs.readFile(TRADES_PATH, "utf8");
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as TradeRecord[];
    if (Array.isArray(parsed.trades)) return parsed.trades as TradeRecord[];
    return [];
  } catch (err) {
    console.error("[/api/auto-manage] Failed to parse trades.json:", err);
    return [];
  }
}

async function writeTrades(trades: TradeRecord[]) {
  const data = JSON.stringify(trades, null, 2);
  await fs.writeFile(TRADES_PATH, data, "utf8");
}

function computeR(
  side: Direction,
  entry: number,
  stop: number,
  current: number
): number {
  if (side === "LONG") {
    const riskPerShare = entry - stop;
    if (riskPerShare <= 0) return 0;
    return (current - entry) / riskPerShare;
  } else {
    const riskPerShare = stop - entry;
    if (riskPerShare <= 0) return 0;
    return (entry - current) / riskPerShare;
  }
}

function decideSuggestion(
  trade: TradeRecordShape,
  currentPrice: number
): AutoManageAction {
  const { id, ticker, side, quantity, entryPrice, stopPrice } = trade;

  const currentR = computeR(side, entryPrice, stopPrice, currentPrice);

  let suggestion: AutoSuggestionType = "HOLD";
  let reason = "Price within normal range; no action.";

  if (currentR <= -1) {
    suggestion = "STOP_OUT";
    reason = "Price moved -1R or worse; stop-out suggested.";
  } else if (currentR >= 2) {
    suggestion = "TAKE_PARTIAL_2R";
    reason = "Price reached >= 2R; take remaining position.";
  } else if (currentR >= 1) {
    suggestion = "TAKE_PARTIAL_1R";
    reason = "Price reached >= 1R; take partial profits.";
  }

  const qtyToExecute =
    suggestion === "TAKE_PARTIAL_1R" || suggestion === "TAKE_PARTIAL_2R"
      ? Math.max(1, Math.floor(quantity / 2))
      : quantity;

  return {
    tradeId: id,
    ticker,
    side,
    quantity,
    currentPrice,
    currentR,
    suggestion,
    reason,
    qtyToExecute,
  };
}

export async function GET() {
  return NextResponse.json(
    { ok: true, message: "Auto-manage endpoint is live." },
    { status: 200 }
  );
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as AutoManageRequest;
    const dryRun = body.dryRun !== false;

    const trades = await readTrades();

    const openTrades = trades.filter((t) => {
      const status = (t.status || "").toUpperCase();
      if (status.includes("CLOSED")) return false;
      if ((t as any).managementStage === "CLOSED") return false;
      return true;
    });

    const actions: AutoManageAction[] = [];

    for (const trade of openTrades) {
      try {
        const quote = await getLatestQuote(trade.ticker);
        const price =
          (quote as any)?.last ??
          (quote as any)?.ap ??
          (quote as any)?.bp ??
          (quote as any)?.aprice ??
          (quote as any)?.c ??
          0;

        if (!price || price <= 0) {
          actions.push({
            tradeId: trade.id,
            ticker: trade.ticker,
            side: trade.side,
            quantity: trade.quantity,
            currentPrice: price,
            currentR: 0,
            suggestion: "HOLD",
            reason: "No valid quote price; skipping.",
          });
          continue;
        }

        const action = decideSuggestion(trade, price);
        actions.push(action);
      } catch (err) {
        console.error(
          "[/api/auto-manage] quote error for",
          trade.ticker,
          err
        );
        actions.push({
          tradeId: trade.id,
          ticker: trade.ticker,
          side: trade.side,
          quantity: trade.quantity,
          currentPrice: 0,
          currentR: 0,
          suggestion: "HOLD",
          reason: "Error fetching quote; skipping.",
          error: (err as Error).message,
        });
      }
    }

    if (!dryRun && AUTO_TRADE_ENABLED) {
      const updatedTrades = [...trades];

      for (const action of actions) {
        try {
          if (
            action.suggestion === "TAKE_PARTIAL_1R" ||
            action.suggestion === "TAKE_PARTIAL_2R" ||
            action.suggestion === "STOP_OUT"
          ) {
            const trade = updatedTrades.find(
              (t) => t.id === action.tradeId
            ) as TradeRecord | undefined;
            if (!trade) continue;

            const qty = action.qtyToExecute ?? trade.quantity;
            if (qty <= 0) continue;

            const side = trade.side === "LONG" ? "sell" : "buy";

            const order = await submitOrder({
              symbol: trade.ticker,
              qty,
              side,
              type: "market",
              timeInForce: "day",
            });

            action.executed = true;
            action.reason += ` Order sent: ${order.id}`;

            trade.quantity = Math.max(0, trade.quantity - qty);

            if (trade.quantity === 0) {
              (trade as any).managementStage = "CLOSED";
              trade.status = "BROKER_FILLED";
            } else if (action.suggestion === "TAKE_PARTIAL_1R") {
              (trade as any).managementStage = "ONE_R_TAKEN";
            } else if (action.suggestion === "TAKE_PARTIAL_2R") {
              (trade as any).managementStage = "TWO_R_TAKEN";
            }
          }
        } catch (err) {
          console.error(
            "[/api/auto-manage] execution error for",
            action.ticker,
            err
          );
          action.error = (err as Error).message;
          action.executed = false;
        }
      }

      await writeTrades(updatedTrades);
    }

    return NextResponse.json(
      {
        ok: true,
        dryRun,
        autoTradeEnabled: AUTO_TRADE_ENABLED,
        evaluated: actions.length,
        actions,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("[/api/auto-manage] POST error:", err);
    return NextResponse.json(
      { ok: false, error: "Auto-manage failed." },
      { status: 500 }
    );
  }
}
