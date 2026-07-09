import { NextResponse } from "next/server";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import { syncStopForTrade } from "@/lib/autoManage/stopSync";

export const dynamic = "force-dynamic";

async function authCronToken(req: Request): Promise<{ ok: boolean; error?: string }> {
  const token = req.headers.get("x-cron-token") || "";
  const expected = process.env.CRON_TOKEN || process.env.CRON_SECRET || "";

  if (!expected) {
    return { ok: false, error: "CRON_TOKEN not configured" };
  }

  if (token !== expected) {
    return { ok: false, error: "unauthorized" };
  }

  return { ok: true };
}

export async function POST(req: Request) {
  const now = new Date().toISOString();

  // Check auth
  const auth = await authCronToken(req);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error || "unauthorized" },
      { status: 401 }
    );
  }

  try {
    // Parse query params
    const { searchParams } = new URL(req.url);
    const tradeId = searchParams.get("tradeId") || "";
    const force = searchParams.get("force") === "1";

    if (!tradeId) {
      return NextResponse.json(
        { ok: false, error: "missing_tradeId" },
        { status: 400 }
      );
    }

    // Load trades
    const trades = await readTrades();
    const idx = trades.findIndex((t: any) => t.id === tradeId);

    if (idx === -1) {
      return NextResponse.json(
        { ok: false, error: "trade_not_found", tradeId },
        { status: 404 }
      );
    }

    const trade = trades[idx];
    const ticker = String(trade.ticker || "").toUpperCase();
    const side = String(trade.side || "").toUpperCase();
    const status = String(trade.status || "").toUpperCase();

    // Validate trade state
    if (status !== "OPEN" && status !== "PARTIAL") {
      return NextResponse.json(
        {
          ok: false,
          error: "invalid_trade_status",
          tradeId,
          ticker,
          status,
          detail: "trade must be OPEN or PARTIAL to sync stop",
        },
        { status: 400 }
      );
    }

    if (!ticker || !side || !Number.isFinite(trade.stopPrice)) {
      return NextResponse.json(
        {
          ok: false,
          error: "incomplete_trade",
          tradeId,
          ticker,
          detail: "trade missing ticker, side, or stopPrice",
        },
        { status: 400 }
      );
    }

    // Call syncStopForTrade with current stop (no adjustment, just sync)
    const nextStopPrice = Number(trade.stopPrice);
    const syncResult = await syncStopForTrade(trade, nextStopPrice);

    // Persist result to trade record
    const updatedTrade = {
      ...trade,
      autoManage: {
        ...(trade.autoManage || {}),
        lastStopSyncAt: now,
        lastStopSyncStatus: syncResult.ok ? "OK" : "FAIL",
        lastStopSyncError: syncResult.ok ? undefined : `${syncResult.error}${syncResult.detail ? ":" + syncResult.detail : ""}`,
        lastStopSyncCancelled: syncResult.ok ? syncResult.cancelled : undefined,
        forcedSyncAt: force ? now : undefined,
      },
      updatedAt: now,
    };

    if (syncResult.ok) {
      updatedTrade.stopOrderId = syncResult.stopOrderId;
    }

    trades[idx] = updatedTrade;
    await writeTrades(trades);

    // Return result
    const response = {
      ok: syncResult.ok,
      tradeId,
      ticker,
      side,
      stopPrice: nextStopPrice,
      status,
      forced: force ? true : undefined,
      result: syncResult.ok
        ? {
            ok: true,
            qty: syncResult.qty,
            stopOrderId: syncResult.stopOrderId,
            cancelled: syncResult.cancelled,
            quantizationNote: syncResult.quantizationNote,
          }
        : {
            ok: false,
            error: syncResult.error,
            detail: syncResult.detail,
            quantizationNote: syncResult.quantizationNote,
          },
      timestamp: now,
    };

    const status_code = syncResult.ok ? 200 : 500;
    return NextResponse.json(response, { status: status_code });
  } catch (err: any) {
    return NextResponse.json(
      {
        ok: false,
        error: "stop_sync_error",
        detail: err?.message || String(err),
        timestamp: now,
      },
      { status: 500 }
    );
  }
}
