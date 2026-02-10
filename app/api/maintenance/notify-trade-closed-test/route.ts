import { NextRequest, NextResponse } from "next/server";
import { readTrades } from "@/lib/tradesStore";
import { notify } from "@/lib/notifications/notify";
import { buildTradeClosedPayload } from "@/lib/notifications/tradeClose";

export const dynamic = "force-dynamic";

/**
 * POST /api/maintenance/notify-trade-closed-test?tradeId=<id>
 *
 * Smoke test endpoint for TRADE_CLOSED notifications.
 * Loads a trade by ID and sends the exact notification payload
 * that would be sent when the trade is finalized.
 *
 * Returns:
 * {
 *   ok: true,
 *   tradeId: string,
 *   ticker: string,
 *   sent: boolean,
 *   skippedReason?: string,
 *   payload: { title: string, message: string }
 * }
 */
export async function POST(req: NextRequest) {
  // Check authorization
  const token = req.headers.get("x-cron-token") || "";
  if (!process.env.CRON_TOKEN || token !== process.env.CRON_TOKEN) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 }
    );
  }

  const url = new URL(req.url);
  const tradeId = url.searchParams.get("tradeId");

  if (!tradeId) {
    return NextResponse.json(
      { ok: false, error: "missing_trade_id" },
      { status: 400 }
    );
  }

  // Load trades and find the requested trade
  const trades = await readTrades();
  const trade = trades.find((t: any) => t.id === tradeId);

  if (!trade) {
    return NextResponse.json(
      { ok: false, error: "trade_not_found", tradeId },
      { status: 404 }
    );
  }

  // Build the notification payload
  const payload = buildTradeClosedPayload(trade);

  // Send the notification (with skipDedupe to allow testing)
  try {
    const notifyResult = await notify({
      type: "TRADE_CLOSED",
      tradeId: trade.id,
      ticker: trade.ticker,
      paper: true, // Paper-first: these are paper trades
      title: payload.title,
      message: payload.message,
      tier: "B",
      skipDedupe: true, // Skip dedupe for testing
    });

    return NextResponse.json({
      ok: true,
      tradeId: trade.id,
      ticker: trade.ticker,
      sent: notifyResult.sent,
      skippedReason: notifyResult.skippedReason,
      payload,
      trade: {
        id: trade.id,
        ticker: trade.ticker,
        status: trade.status,
        closeReason: trade.closeReason,
        realizedR: trade.realizedR,
        realizedPnL: trade.realizedPnL,
        entryPrice: trade.entryPrice,
        closePrice: trade.closePrice,
      },
    });
  } catch (err) {
    console.error("[notify-trade-closed-test] error", {
      tradeId,
      error: String(err),
    });

    return NextResponse.json(
      {
        ok: false,
        error: "notification_exception",
        tradeId,
        detail: String(err),
      },
      { status: 500 }
    );
  }
}
