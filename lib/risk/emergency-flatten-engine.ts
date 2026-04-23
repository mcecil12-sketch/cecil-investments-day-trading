/**
 * Emergency Flatten Engine
 *
 * Canonical lifecycle handler for the emergency-flatten recovery path.
 * Used by protection-recover, live-protection, maintenance reconcile,
 * and agent-driven ops.  This is the single recovery engine — no ad-hoc
 * flatten paths should exist elsewhere.
 *
 * Lifecycle states
 * ─────────────────
 *  FLATTEN_PENDING            Repair failed; flatten not yet started
 *  FLATTEN_IN_PROGRESS        Close order submitted and active at broker
 *  FLATTEN_PARTIALLY_FILLED   Close order partially filled; residual exposure remains
 *  FLATTEN_FAILED             Close order rejected / failed; position still unprotected
 *  EMERGENCY_EXIT_COMPLETE    Position confirmed flat by broker
 *  ALREADY_FLAT               Position was already flat before this call
 *
 * Key guarantees
 * ─────────────────
 *  1. Always force-refreshes broker truth — never uses stale 45s cache.
 *  2. Checks for existing active close order BEFORE submitting — prevents
 *     double-ordering.
 *  3. Partial fills are tracked as FLATTEN_PARTIALLY_FILLED (not failure).
 *  4. Residual exposure continues through autonomous close until flat.
 *  5. Auto-detects ALREADY_FLAT and allows callers to retire the blocker.
 */

import { alpacaRequest } from "@/lib/alpaca";
import { clearBrokerTruthCache, fetchBrokerTruth } from "@/lib/broker/truth";
import { saveCriticalTask, retireStaleCriticalTask, getCriticalTasks } from "@/lib/redis";

// ─── Constants ───────────────────────────────────────────────────────

/** Alpaca order statuses that mean a close order is still alive. */
const ACTIVE_CLOSE_STATUSES = new Set([
  "new",
  "accepted",
  "pending_new",
  "pending_replace",
  "accepted_for_bidding",
  "partially_filled",
  "held",
]);

/** Alpaca order statuses that mean a close order has permanently stopped. */
const TERMINAL_CLOSE_STATUSES = new Set([
  "canceled",
  "cancelled",
  "rejected",
  "expired",
  "done_for_day",
  "stopped",
  "replaced",
]);

function closeSideFor(tradeSide: string): "sell" | "buy" {
  return String(tradeSide).toUpperCase() === "SHORT" ? "buy" : "sell";
}

// ─── Exported Types ───────────────────────────────────────────────────

export type FlattenLifecycleState =
  | "FLATTEN_PENDING"
  | "FLATTEN_IN_PROGRESS"
  | "FLATTEN_PARTIALLY_FILLED"
  | "FLATTEN_FAILED"
  | "EMERGENCY_EXIT_COMPLETE"
  | "ALREADY_FLAT";

/** Structured diagnostics surfaced in funnel-health and agent responses. */
export type FlattenLifecycleDiagnostic = {
  blockerCode: string;
  tradeId: string;
  symbol: string;
  recoveryState: FlattenLifecycleState | "none";
  brokerPositionQty: number;
  activeCloseOrderDetected: boolean;
  activeCloseOrderId?: string;
  activeCloseOrderStatus?: string;
  residualQty: number;
  repairAttempted: boolean;
  repairSucceeded: boolean;
  flattenAttempted: boolean;
  flattenOrderId?: string;
  flattenProgress?: string;
  nextAction: string;
};

export type ContinueFlattenResult = {
  ok: boolean;
  state: FlattenLifecycleState;
  /** True when the broker position is now confirmed flat (qty = 0). */
  isFlat: boolean;
  /** Absolute broker position qty at time of evaluation. 0 if flat. */
  brokerPositionQty: number;
  /** True when an active close order already exists — no new order submitted. */
  activeCloseOrderDetected: boolean;
  activeCloseOrderId?: string;
  activeCloseOrderStatus?: string;
  /** Shares already filled by the active/previous close order. */
  filledQty: number;
  /** Shares still open (brokerPositionQty when position exists). */
  residualQty: number;
  /** True when this call submitted a new close order. */
  closeOrderSubmitted: boolean;
  closeOrderId?: string;
  detail: string;
  error?: string;
};

// ─── Core Function ────────────────────────────────────────────────────

/**
 * Continue (or start) the emergency flatten lifecycle for a position.
 *
 * Safe to call repeatedly on each protection cycle — it will not submit
 * a duplicate close order when one is already active at Alpaca.
 *
 * @param opts.symbol    Ticker (case-insensitive).
 * @param opts.tradeSide "LONG" or "SHORT" — determines close order side.
 * @param opts.tradeId   DB trade ID (for logging / Redis context).
 */
export async function continueFlattenLifecycle(opts: {
  symbol: string;
  tradeSide: string;
  tradeId: string;
}): Promise<ContinueFlattenResult> {
  const ticker = opts.symbol.toUpperCase();
  const closeSide = closeSideFor(opts.tradeSide);

  // ── 1. Force-refresh broker truth (never stale 45s cache) ────────
  await clearBrokerTruthCache();
  const brokerTruth = await fetchBrokerTruth();

  // ── 2. Check current position qty ────────────────────────────────
  const pos = (brokerTruth.positions as any[]).find(
    (p) => String(p.symbol ?? "").toUpperCase() === ticker,
  );
  const currentQty = Math.abs(Number(pos?.qty ?? 0));

  if (currentQty === 0) {
    console.log("[emergency-flatten] position already flat", {
      ticker,
      tradeId: opts.tradeId,
    });
    return {
      ok: true,
      state: "ALREADY_FLAT",
      isFlat: true,
      brokerPositionQty: 0,
      activeCloseOrderDetected: false,
      filledQty: 0,
      residualQty: 0,
      closeOrderSubmitted: false,
      detail: "position_already_flat",
    };
  }

  // ── 3. Scan for existing active market close order ────────────────
  // A close order = market order on the closing side (sell for LONG, buy for SHORT).
  // We never want to submit a duplicate when one is already in flight.
  const symbolOrders = (brokerTruth.openOrders as any[]).filter(
    (o) => String(o.symbol ?? "").toUpperCase() === ticker,
  );

  const activeCloseOrder = symbolOrders.find((o) => {
    const side = String(o.side ?? "").toLowerCase();
    const status = String(o.status ?? "").toLowerCase();
    const type = String(o.type ?? "").toLowerCase();
    return side === closeSide && type === "market" && ACTIVE_CLOSE_STATUSES.has(status);
  });

  if (activeCloseOrder) {
    const status = String(activeCloseOrder.status ?? "").toLowerCase();
    const filledQty = Math.abs(Number(activeCloseOrder.filled_qty ?? activeCloseOrder.qty_filled ?? 0));
    const state: FlattenLifecycleState =
      status === "partially_filled" ? "FLATTEN_PARTIALLY_FILLED" : "FLATTEN_IN_PROGRESS";

    console.log("[emergency-flatten] active close order detected; monitoring (no duplicate)", {
      ticker,
      tradeId: opts.tradeId,
      closeOrderId: activeCloseOrder.id,
      status,
      filledQty,
      positionQty: currentQty,
      state,
    });

    return {
      ok: true,
      state,
      isFlat: false,
      brokerPositionQty: currentQty,
      activeCloseOrderDetected: true,
      activeCloseOrderId: String(activeCloseOrder.id),
      activeCloseOrderStatus: status,
      filledQty,
      residualQty: currentQty,
      closeOrderSubmitted: false,
      detail: `close_order_active: id=${activeCloseOrder.id} status=${status} brokerQty=${currentQty} filled=${filledQty}`,
    };
  }

  // ── 4. No active close order — cancel blocking orders then submit ─
  // Cancel any open stop/limit orders that might compete for qty.
  // (Market orders are not affected by quantity holds from other orders in
  //  Alpaca paper — but we cancel defensively to prevent "qty unavailable".)
  for (const order of symbolOrders) {
    const status = String(order.status ?? "").toLowerCase();
    const type = String(order.type ?? "").toLowerCase();
    // Cancel stops, limits, and any non-market orders in active state
    if (ACTIVE_CLOSE_STATUSES.has(status) && type !== "market" && order.id) {
      await alpacaRequest({
        method: "DELETE",
        path: `/v2/orders/${encodeURIComponent(String(order.id))}`,
      }).catch((err) => {
        console.warn("[emergency-flatten] cancel order failed (non-fatal)", {
          orderId: order.id,
          err: String(err),
        });
      });
    }
  }

  // ── 5. Submit market close order ─────────────────────────────────
  const orderBody = {
    symbol: ticker,
    qty: String(currentQty),
    side: closeSide,
    type: "market",
    time_in_force: "day",
  };

  console.log("[emergency-flatten] submitting close order", {
    ticker,
    tradeId: opts.tradeId,
    qty: currentQty,
    closeSide,
  });

  try {
    const submitResp = await alpacaRequest({
      method: "POST",
      path: "/v2/orders",
      body: orderBody,
    });

    if (!submitResp.ok) {
      console.error("[emergency-flatten] close order submission failed", {
        ticker,
        qty: currentQty,
        httpStatus: submitResp.status,
        body: submitResp.text,
      });
      return {
        ok: false,
        state: "FLATTEN_FAILED",
        isFlat: false,
        brokerPositionQty: currentQty,
        activeCloseOrderDetected: false,
        filledQty: 0,
        residualQty: currentQty,
        closeOrderSubmitted: false,
        error: `order_submit_failed: HTTP ${submitResp.status} — ${submitResp.text}`,
        detail: "close_order_submission_failed",
      };
    }

    let closeOrder: any = {};
    try {
      closeOrder = JSON.parse(submitResp.text);
    } catch {
      // non-JSON response — continue, order may still have been accepted
    }

    console.log("[emergency-flatten] close order submitted successfully", {
      ticker,
      tradeId: opts.tradeId,
      closeOrderId: closeOrder.id,
      qty: currentQty,
      closeSide,
    });

    return {
      ok: true,
      state: "FLATTEN_IN_PROGRESS",
      isFlat: false,
      brokerPositionQty: currentQty,
      activeCloseOrderDetected: false,
      filledQty: 0,
      residualQty: currentQty,
      closeOrderSubmitted: true,
      closeOrderId: String(closeOrder.id ?? ""),
      detail: `close_order_submitted: id=${closeOrder.id ?? "?"} qty=${currentQty} side=${closeSide}`,
    };
  } catch (err: any) {
    const errMsg = err?.message ?? String(err);
    console.error("[emergency-flatten] close order threw", { ticker, err: errMsg });
    return {
      ok: false,
      state: "FLATTEN_FAILED",
      isFlat: false,
      brokerPositionQty: currentQty,
      activeCloseOrderDetected: false,
      filledQty: 0,
      residualQty: currentQty,
      closeOrderSubmitted: false,
      error: `order_submit_threw: ${errMsg}`,
      detail: "close_order_submission_threw",
    };
  }
}

// ─── Redis Lifecycle Helpers ──────────────────────────────────────────

/**
 * Persist a flatten-lifecycle Redis incident for a symbol.
 * Replaces any previous flatten incident code for the same symbol+date
 * because saveCriticalTask dedupes by code:symbol:date.
 */
export async function saveFlattenIncident(opts: {
  incidentCode: "FLATTEN_IN_PROGRESS" | "FLATTEN_PARTIALLY_FILLED" | "FLATTEN_FAILED";
  symbol: string;
  tradeId: string;
  detail: string;
}): Promise<void> {
  await saveCriticalTask({
    incidentCode: opts.incidentCode,
    symbol: opts.symbol,
    severity: "CRITICAL",
    detail: `[emergency-flatten] ${opts.incidentCode} tradeId=${opts.tradeId}: ${opts.detail}`,
  }).catch(() => {});
}

/**
 * Retire all open flatten-lifecycle incidents for a symbol once the
 * position is confirmed flat (EMERGENCY_EXIT_COMPLETE or ALREADY_FLAT).
 */
export async function retireFlattenIncidents(
  symbol: string,
  reason: string,
): Promise<void> {
  try {
    const allTasks = await getCriticalTasks();
    const sym = symbol.toUpperCase();
    const flattenCodes = new Set([
      "FLATTEN_IN_PROGRESS",
      "FLATTEN_PARTIALLY_FILLED",
      "FLATTEN_FAILED",
      "STOP_REPAIR_FAILED",
      "MISSING_STOP",
    ]);
    for (const task of allTasks) {
      if (
        String(task.symbol ?? "").toUpperCase() === sym &&
        flattenCodes.has(task.incidentCode)
      ) {
        await retireStaleCriticalTask(task.id, reason).catch(() => {});
      }
    }
  } catch {
    // Non-fatal — best effort
  }
}
