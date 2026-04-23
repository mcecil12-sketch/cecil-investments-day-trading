/**
 * Stop Verification & Recovery Helpers
 * 
 * Ensures no trade can remain OPEN without verified stop protection at broker.
 * Part of the production hardening initiative.
 */

import { alpacaRequest, getOrder, createOrder } from "@/lib/alpaca";
import { fetchBrokerTruth, type BrokerTruth } from "@/lib/broker/truth";
import { findProtectiveStopOrder } from "@/lib/trades/protection";
import { normalizeStopPrice, tickForEquityPrice } from "@/lib/tickSize";
import { saveCriticalTask } from "@/lib/redis";

export interface VerifyStopResult {
  ok: boolean;
  verified: boolean;
  stopOrderId?: string | null;
  stopStatus?: string;
  brokerStopPrice?: number;
  reason?: string;
  detail?: string;
}

export interface RecoverResult {
  ok: boolean;
  action: "none" | "stop_created" | "position_flattened" | "entry_canceled";
  stopOrderId?: string | null;
  reason?: string;
  detail?: string;
}

/**
 * Verify that a stop order exists and is active at broker for a given trade.
 * Checks both the tracked stopOrderId and scans open orders for protective stops.
 * 
 * @param params.symbol - The ticker symbol
 * @param params.side - "LONG" or "SHORT"
 * @param params.stopOrderId - The tracked stop order ID (from bracket or standalone)
 * @param params.brokerTruth - Optional pre-fetched broker truth (avoids double fetch)
 */
export async function verifyStopAtBroker(params: {
  symbol: string;
  side: "LONG" | "SHORT";
  stopOrderId?: string | null;
  brokerTruth?: BrokerTruth;
}): Promise<VerifyStopResult> {
  const { symbol, side, stopOrderId } = params;
  const ticker = symbol.toUpperCase();

  // Fetch fresh broker truth if not provided
  const brokerTruth = params.brokerTruth ?? await fetchBrokerTruth();
  
  if (brokerTruth.error) {
    return {
      ok: false,
      verified: false,
      reason: "broker_unavailable",
      detail: brokerTruth.error,
    };
  }

  const openOrders = brokerTruth.openOrders || [];
  const symbolOrders = openOrders.filter(
    (o) => (o.symbol || "").toUpperCase() === ticker
  );

  // Check 1: If we have a tracked stopOrderId, verify it's active
  if (stopOrderId) {
    const trackedOrder = symbolOrders.find((o) => o.id === stopOrderId);
    if (trackedOrder) {
      const status = (trackedOrder.status || "").toLowerCase();
      // Use the full set of active statuses — Alpaca uses pending_new, not just pending
      const isActive = ["new", "accepted", "pending_new", "pending_replace", "held", "accepted_for_bidding"].includes(status);
      if (isActive) {
        console.log("[stop-verify] tracked stop verified active", { ticker, stopOrderId, status });
        return {
          ok: true,
          verified: true,
          stopOrderId,
          stopStatus: status,
        };
      }
    }
    
    // Tracked stop exists but not in open orders - it may have been filled/canceled
    // Fall through to check for any protective stop
    console.log("[stop-verify] tracked stopOrderId not in open orders, scanning all orders", { ticker, stopOrderId });
  }

  // Check 2: Scan all open orders for a protective stop (pass stop_price for fallback detection)
  const protectiveStop = findProtectiveStopOrder({
    ticker,
    tradeSide: side,
    openOrders: symbolOrders.map((o) => ({
      id: o.id,
      symbol: o.symbol,
      side: o.side,
      type: o.type || "",
      status: o.status,
      stop_price: (o as any).stop_price, // pass through from broker truth
    })),
  });

  if (protectiveStop) {
    console.log("[stop-verify] found protective stop via scan", { ticker, stopOrderId: protectiveStop.id });
    return {
      ok: true,
      verified: true,
      stopOrderId: protectiveStop.id,
      stopStatus: "active", // We found it in open orders, so it's active
    };
  }

  // No active stop found
  console.warn("[stop-verify] NO ACTIVE STOP FOUND", { ticker, side, trackedStopOrderId: stopOrderId });
  return {
    ok: true,
    verified: false,
    stopOrderId: null,
    reason: "no_active_stop",
    detail: stopOrderId
      ? `Tracked stopOrderId=${stopOrderId} not in broker open orders; no other protective stop found`
      : "No tracked stop order ID and no protective stop found in open orders",
  };
}

/**
 * Verify stop order directly by ID (bypasses broker truth cache).
 * Uses GET /v2/orders/:id for real-time status.
 */
export async function verifyStopOrderDirect(orderId: string): Promise<{
  ok: boolean;
  active: boolean;
  status?: string;
  error?: string;
}> {
  if (!orderId) {
    return { ok: false, active: false, error: "no_order_id" };
  }

  try {
    const order = await getOrder(orderId);
    const status = String((order as any)?.status || "").toLowerCase();
    const activeStatuses = ["pending", "accepted", "held", "new"];
    const isActive = activeStatuses.includes(status);

    console.log("[stop-verify-direct] order status", { orderId, status, isActive });
    return {
      ok: true,
      active: isActive,
      status,
    };
  } catch (err: any) {
    const message = String(err?.message || err || "unknown");
    console.error("[stop-verify-direct] failed to fetch order", { orderId, error: message });
    return {
      ok: false,
      active: false,
      error: message,
    };
  }
}

/**
 * Recover an unprotected trade by submitting an emergency stop.
 * Uses 2% from avg entry price as emergency stop level.
 * 
 * @param params.symbol - The ticker symbol
 * @param params.side - "LONG" or "SHORT"
 * @param params.qty - Position quantity
 * @param params.avgEntryPrice - Average entry price
 * @param params.preferredStopPrice - Optional preferred stop price (uses 2% emergency if not provided)
 */
export async function recoverUnprotectedTrade(params: {
  symbol: string;
  side: "LONG" | "SHORT";
  qty: number;
  avgEntryPrice: number;
  preferredStopPrice?: number;
  tradeId?: string;
}): Promise<RecoverResult> {
  const { symbol, side, qty, avgEntryPrice, preferredStopPrice, tradeId } = params;
  const ticker = symbol.toUpperCase();

  if (!ticker || !qty || qty <= 0 || !avgEntryPrice || avgEntryPrice <= 0) {
    return {
      ok: false,
      action: "none",
      reason: "invalid_params",
      detail: `symbol=${ticker} qty=${qty} avgEntryPrice=${avgEntryPrice}`,
    };
  }

  // Calculate emergency stop price (2% from entry)
  const emergencyStopPrice = preferredStopPrice
    ? preferredStopPrice
    : side === "LONG"
      ? Math.round(avgEntryPrice * 0.98 * 100) / 100
      : Math.round(avgEntryPrice * 1.02 * 100) / 100;

  const stopSide: "buy" | "sell" = side === "LONG" ? "sell" : "buy";

  // Normalize stop price for tick compliance
  const tick = tickForEquityPrice(avgEntryPrice);
  const normResult = normalizeStopPrice({
    side,
    entryPrice: avgEntryPrice,
    stopPrice: emergencyStopPrice,
    tick,
  });

  const finalStopPrice = normResult.ok ? normResult.stop : emergencyStopPrice;

  console.log("[stop-recovery] submitting emergency stop", {
    ticker,
    side,
    qty,
    avgEntryPrice,
    emergencyStopPrice,
    finalStopPrice,
    tradeId,
  });

  try {
    const stopOrder = await createOrder({
      symbol: ticker,
      qty,
      side: stopSide,
      type: "stop",
      time_in_force: "gtc",
      stop_price: finalStopPrice,
      extended_hours: false,
    });

    const stopOrderId = String((stopOrder as any)?.id || "");
    if (!stopOrderId) {
      return {
        ok: false,
        action: "none",
        reason: "stop_order_missing_id",
        detail: "Alpaca returned order without ID",
      };
    }

    // Verify the stop is active
    const verify = await verifyStopOrderDirect(stopOrderId);
    if (!verify.active) {
      console.error("[stop-recovery] recovery stop not active after creation", {
        ticker,
        stopOrderId,
        status: verify.status,
        error: verify.error,
      });
      return {
        ok: false,
        action: "none",
        reason: "recovery_stop_not_active",
        detail: `stopOrderId=${stopOrderId} status=${verify.status}`,
      };
    }

    console.log("[stop-recovery] emergency stop created and verified", {
      ticker,
      stopOrderId,
      stopPrice: finalStopPrice,
      tradeId,
    });

    return {
      ok: true,
      action: "stop_created",
      stopOrderId,
      reason: "emergency_stop_placed",
      detail: `stopPrice=${finalStopPrice}`,
    };
  } catch (err: any) {
    const message = String(err?.message || err || "unknown");
    console.error("[stop-recovery] failed to create emergency stop", {
      ticker,
      error: message,
      tradeId,
    });
    return {
      ok: false,
      action: "none",
      reason: "stop_creation_failed",
      detail: message,
    };
  }
}

/**
 * Flatten (close) an unprotected position when stop recovery fails.
 * This is the nuclear option - used only when we can't establish protection.
 */
export async function flattenUnprotectedPosition(params: {
  symbol: string;
  tradeId?: string;
  reason?: string;
}): Promise<RecoverResult> {
  const { symbol, tradeId, reason } = params;
  const ticker = symbol.toUpperCase();

  console.warn("[stop-recovery] FLATTENING unprotected position", { ticker, tradeId, reason });

  try {
    const resp = await alpacaRequest({
      method: "DELETE",
      path: `/v2/positions/${encodeURIComponent(ticker)}`,
    });

    if (!resp.ok && resp.status !== 404) {
      const errorText = resp.text || `HTTP ${resp.status}`;
      console.error("[stop-recovery] flatten failed", { ticker, error: errorText });
      return {
        ok: false,
        action: "none",
        reason: "flatten_failed",
        detail: errorText,
      };
    }

    // Log critical task for audit trail
    await saveCriticalTask({
      incidentCode: "EMERGENCY_FLATTEN",
      symbol: ticker,
      severity: "CRITICAL",
      detail: `Position flattened due to: ${reason || "unable_to_establish_stop_protection"}; tradeId=${tradeId || "unknown"}`,
    }).catch((err) => console.error("[stop-recovery] failed to log critical task", err));

    console.log("[stop-recovery] position flattened", { ticker, tradeId });
    return {
      ok: true,
      action: "position_flattened",
      reason: "emergency_flatten",
      detail: reason || "unable_to_establish_stop_protection",
    };
  } catch (err: any) {
    const message = String(err?.message || err || "unknown");
    console.error("[stop-recovery] flatten error", { ticker, error: message });
    return {
      ok: false,
      action: "none",
      reason: "flatten_error",
      detail: message,
    };
  }
}

/**
 * Cancel a pending entry order when stop verification fails during execution.
 */
export async function cancelPendingEntry(orderId: string): Promise<RecoverResult> {
  if (!orderId) {
    return {
      ok: false,
      action: "none",
      reason: "no_order_id",
    };
  }

  console.log("[stop-recovery] canceling pending entry", { orderId });

  try {
    const resp = await alpacaRequest({
      method: "DELETE",
      path: `/v2/orders/${encodeURIComponent(orderId)}`,
    });

    if (!resp.ok && resp.status !== 404 && resp.status !== 422) {
      const errorText = resp.text || `HTTP ${resp.status}`;
      console.error("[stop-recovery] cancel entry failed", { orderId, error: errorText });
      return {
        ok: false,
        action: "none",
        reason: "cancel_failed",
        detail: errorText,
      };
    }

    console.log("[stop-recovery] entry order canceled", { orderId });
    return {
      ok: true,
      action: "entry_canceled",
      reason: "entry_canceled_missing_stop",
    };
  } catch (err: any) {
    const message = String(err?.message || err || "unknown");
    console.error("[stop-recovery] cancel entry error", { orderId, error: message });
    return {
      ok: false,
      action: "none",
      reason: "cancel_error",
      detail: message,
    };
  }
}
