/**
 * GET /api/trades/protection-audit
 * Audits open trades for broker-truth stop protection integrity.
 * Flags missing, expired, or canceled protective stops with detailed issues.
 */
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { readTrades } from "@/lib/tradesStore";
import { fetchBrokerTruth } from "@/lib/broker/truth";
import { getOrder } from "@/lib/alpaca";
import {
  classifyOrderTerminalStatus,
  findProtectiveStopOrder,
  isOpenTradeStatus,
  normalizeTicker,
  normalizeTradeSide,
  ProtectionStatus,
} from "@/lib/trades/protection";

type AnyTrade = Record<string, any>;

type AuditIssue = {
  id: string;
  ticker: string;
  side: string;
  status: string;
  protectionStatus: ProtectionStatus;
  issue: string;
  detail?: string;
  trackedStopOrderId?: string;
  lastProtectionCheckAt?: string;
};

async function classifyTradeProtection(args: {
  trade: AnyTrade;
  symbolOpenOrders: any[];
  brokerQty: number;
}): Promise<AuditIssue | null> {
  const trade = args.trade;
  const ticker = normalizeTicker(trade.ticker);
  const side = normalizeTradeSide(trade.side);
  const status = String(trade.status || "");
  const trackedStopOrderId = String(trade.stopOrderId || "") || undefined;

  if (!(args.brokerQty > 0)) {
    return null;
  }

  if (!side) {
    return {
      id: String(trade.id || ""),
      ticker,
      side: String(trade.side || ""),
      status,
      protectionStatus: "MISSING_STOP",
      issue: "invalid_trade_side",
      detail: "trade side is not LONG/SHORT",
      trackedStopOrderId,
      lastProtectionCheckAt: trade.lastProtectionCheckAt,
    };
  }

  const protective = findProtectiveStopOrder({
    ticker,
    tradeSide: side,
    openOrders: args.symbolOpenOrders,
  });
  if (protective) {
    return null;
  }

  if (!trackedStopOrderId) {
    return {
      id: String(trade.id || ""),
      ticker,
      side,
      status,
      protectionStatus: "MISSING_STOP",
      issue: "missing_stop",
      detail: "no open protective stop found at broker",
      lastProtectionCheckAt: trade.lastProtectionCheckAt,
    };
  }

  try {
    const tracked = await getOrder(trackedStopOrderId);
    const orderStatus = String((tracked as any)?.status || "").toLowerCase();
    const terminal = classifyOrderTerminalStatus(orderStatus);
    if (terminal === "EXPIRED") {
      return {
        id: String(trade.id || ""),
        ticker,
        side,
        status,
        protectionStatus: "STOP_EXPIRED",
        issue: "stop_expired",
        detail: `tracked stop status=${orderStatus}`,
        trackedStopOrderId,
        lastProtectionCheckAt: trade.lastProtectionCheckAt,
      };
    }
    if (terminal === "CANCELED") {
      return {
        id: String(trade.id || ""),
        ticker,
        side,
        status,
        protectionStatus: "STOP_CANCELED",
        issue: "stop_canceled",
        detail: `tracked stop status=${orderStatus}`,
        trackedStopOrderId,
        lastProtectionCheckAt: trade.lastProtectionCheckAt,
      };
    }
    return {
      id: String(trade.id || ""),
      ticker,
      side,
      status,
      protectionStatus: "MISSING_STOP",
      issue: "missing_stop",
      detail: `no open protective stop found; tracked status=${orderStatus || "unknown"}`,
      trackedStopOrderId,
      lastProtectionCheckAt: trade.lastProtectionCheckAt,
    };
  } catch (err: any) {
    return {
      id: String(trade.id || ""),
      ticker,
      side,
      status,
      protectionStatus: "MISSING_STOP",
      issue: "tracked_stop_lookup_failed",
      detail: String(err?.message || err),
      trackedStopOrderId,
      lastProtectionCheckAt: trade.lastProtectionCheckAt,
    };
  }
}

export async function GET() {
  const [allTrades, brokerTruth] = await Promise.all([
    readTrades<AnyTrade>().catch(() => []),
    fetchBrokerTruth(),
  ]);

  if (brokerTruth.error) {
    return NextResponse.json(
      {
        ok: false,
        error: "broker_truth_unavailable",
        detail: brokerTruth.error,
      },
      { status: 502 }
    );
  }

  const openTrades = (Array.isArray(allTrades) ? allTrades : []).filter((t) => isOpenTradeStatus(t?.status));

  const positionsBySymbol = new Map<string, any>();
  for (const pos of brokerTruth.positions || []) {
    const symbol = normalizeTicker((pos as any)?.symbol);
    if (!symbol) continue;
    positionsBySymbol.set(symbol, pos);
  }

  const openOrdersBySymbol = new Map<string, any[]>();
  for (const order of brokerTruth.openOrders || []) {
    const symbol = normalizeTicker((order as any)?.symbol);
    if (!symbol) continue;
    const bucket = openOrdersBySymbol.get(symbol) || [];
    bucket.push(order);
    openOrdersBySymbol.set(symbol, bucket);
  }

  const issues: AuditIssue[] = [];
  let protectedTrades = 0;

  for (const trade of openTrades) {
    const ticker = normalizeTicker(trade?.ticker);
    const brokerPos = positionsBySymbol.get(ticker);
    const brokerQty = Math.abs(Number((brokerPos as any)?.qty ?? 0));
    const classified = await classifyTradeProtection({
      trade,
      symbolOpenOrders: openOrdersBySymbol.get(ticker) || [],
      brokerQty,
    });
    if (classified) {
      issues.push(classified);
    } else {
      protectedTrades += 1;
    }
  }

  const unprotectedTrades = issues.length;
  const protectionRate = openTrades.length > 0 ? Math.round((protectedTrades / openTrades.length) * 10000) / 100 : null;

  return NextResponse.json({
    ok: true,
    brokerFetchedAt: brokerTruth.fetchedAt,
    openTrades: openTrades.length,
    protectedTrades,
    unprotectedTrades,
    expiredStopCount: issues.filter((x) => x.protectionStatus === "STOP_EXPIRED").length,
    canceledStopCount: issues.filter((x) => x.protectionStatus === "STOP_CANCELED").length,
    missingStopCount: issues.filter((x) => x.protectionStatus === "MISSING_STOP").length,
    protectionRate,
    issues,
  });
}
