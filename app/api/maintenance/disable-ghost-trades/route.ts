import { NextResponse } from "next/server";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import type { TradeRecord, TradeStatus } from "@/app/api/trades/route";

export const dynamic = "force-dynamic";

interface DisableGhostTradesResult {
  ok: boolean;
  dryRun: boolean;
  scanned: number;
  disabled: number;
  unchanged: number;
  sample: Array<{
    id: string;
    ticker: string;
    status: TradeStatus;
    brokerOrderId?: string;
    brokerStatus?: string;
    alpacaOrderId?: string;
    alpacaStatus?: string;
  }>;
  reason: string;
}

/**
 * Determines if a trade is broker-backed:
 * - Must have brokerOrderId (or alpacaOrderId) that is non-null
 * - AND brokerStatus (or alpacaStatus) must be "filled" or "partially_filled"
 */
function isBrokerBacked(trade: TradeRecord): boolean {
  const hasBrokerOrder =
    (trade.brokerOrderId != null && (trade.brokerStatus === "filled" || trade.brokerStatus === "partially_filled")) ||
    (trade.alpacaOrderId != null && (trade.alpacaStatus === "filled" || trade.alpacaStatus === "partially_filled"));

  return hasBrokerOrder;
}

/**
 * Determines if a trade is a ghost (should be disabled):
 * - Has a non-terminal status (OPEN, BROKER_PENDING, BROKER_ERROR, NEW, ERROR)
 * - AND is NOT broker-backed
 */
function isGhost(trade: TradeRecord): boolean {
  // Non-terminal statuses that can be ghosted
  const isNonTerminal = ["OPEN", "BROKER_PENDING", "BROKER_ERROR", "NEW", "ERROR"].includes(trade.status);

  if (!isNonTerminal) {
    return false; // Already terminal (CLOSED, DISABLED, etc.)
  }

  return !isBrokerBacked(trade);
}

export async function POST(req: Request): Promise<NextResponse<DisableGhostTradesResult>> {
  // Gate by x-cron-token (same as reconcile-open-trades)
  const token = req.headers.get("x-cron-token") || "";
  const hasSession = req.headers.get("cookie")?.includes("session=") ?? false;
  const hasToken = !!process.env.CRON_TOKEN && token === process.env.CRON_TOKEN;

  if (!hasSession && !hasToken) {
    return NextResponse.json({ ok: false, error: "unauthorized" } as any, { status: 401 });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dryRun !== false; // Default to dryRun=true for safety

    // Read all trades
    const allTrades = await readTrades<TradeRecord>();
    let scanned = 0;
    let disabled = 0;
    const sample: DisableGhostTradesResult["sample"] = [];
    const maxSampleSize = 10;

    const now = new Date().toISOString();

    // Scan and identify ghosts
    const updatedTrades = allTrades.map((trade) => {
      scanned++;

      if (isGhost(trade)) {
        disabled++;

        // Capture sample (limit to first 10)
        if (sample.length < maxSampleSize) {
          sample.push({
            id: trade.id,
            ticker: trade.ticker,
            status: trade.status,
            brokerOrderId: trade.brokerOrderId,
            brokerStatus: trade.brokerStatus,
            alpacaOrderId: trade.alpacaOrderId,
            alpacaStatus: trade.alpacaStatus,
          });
        }

        // Mark as disabled (unless dryRun)
        if (!dryRun) {
          return {
            ...trade,
            status: "DISABLED" as const,
            disabledAt: now,
            disableReason: "ghost_no_broker_filled",
          };
        }
      }

      return trade;
    });

    // Write back if not dryRun
    if (!dryRun) {
      await writeTrades(updatedTrades);
    }

    const unchanged = scanned - disabled;

    return NextResponse.json({
      ok: true,
      dryRun,
      scanned,
      disabled,
      unchanged,
      sample,
      reason: "ghost_no_broker_filled",
    });
  } catch (err: any) {
    console.error("[disable-ghost-trades] error", err);
    return NextResponse.json(
      {
        ok: false,
        error: "Failed to disable ghost trades",
        detail: err?.message ?? String(err),
      } as any,
      { status: 500 }
    );
  }
}
