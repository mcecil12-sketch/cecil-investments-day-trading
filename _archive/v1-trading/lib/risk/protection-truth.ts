/**
 * Current-truth protection evaluator.
 *
 * Determines whether a trade is CURRENTLY protected using live broker state as
 * the PRIMARY source of truth.  Historical DB values (e.g. protectionStatus =
 * "REPAIR_FAILED") are captured for diagnostics but NEVER affect the result.
 *
 * Public API
 * ----------
 *  evaluateTradeProtectionNow(trade, brokerPositions, brokerOrders, opts?)
 *  → TradeProtectionNow
 *
 * The function is pure (no network calls, no side effects) and can be used by:
 *  - protection-integrity audit
 *  - live-protection evaluator
 *  - protection-recover pre-check
 *  - funnel-health per-trade detail
 *  - agent / ops-manager paths
 */

// ─── Active-order status set ─────────────────────────────────────────────────
// All Alpaca order statuses that represent an order that is alive and
// will execute when its trigger conditions are met.  This matches the full set
// used in lib/trades/protection.ts OPEN_ORDER_STATUSES.
export const ACTIVE_ORDER_STATUSES = new Set([
  "new",
  "accepted",
  "pending_new",      // Alpaca-specific: submitted, awaiting ack
  "pending_replace",  // Alpaca-specific: replace request in-flight
  "accepted_for_bidding",
  "partially_filled",
  "held",             // Bracket legs: waiting for parent to fill
]);

// ─── Stop-like order types ─────────────────────────────────────────────────
export const STOP_LIKE_ORDER_TYPES = new Set([
  "stop",
  "stop_limit",
  "trailing_stop",
]);

// ─── Take-profit order types ──────────────────────────────────────────────
export const TAKE_PROFIT_ORDER_TYPES = new Set([
  "limit",
  "take_profit",
]);

// ─── Types ────────────────────────────────────────────────────────────────

/** Minimal broker order shape accepted by this module (superset of BrokerTruth.openOrders). */
export type ProtTruthOrder = {
  id: string;
  symbol?: string;
  side?: string;
  type?: string;
  status?: string;
  stop_price?: string | number | null;
  [key: string]: any;
};

/** Minimal broker position shape. */
export type ProtTruthPosition = {
  symbol: string;
  qty: string | number;
  [key: string]: any;
};

export type TradeProtectionNow = {
  tradeId: string;
  symbol: string;

  // ── Current broker state ─────────────────────────────────────────
  /** True if broker shows a live position (qty > 0) for this symbol. */
  brokerPositionExists: boolean;
  /** True if broker has an active stop-type order on the correct protective side. */
  brokerStopDetected: boolean;
  /** True if broker has an active take-profit order on the correct close side. */
  brokerTakeProfitDetected: boolean;
  /** True if both stop and take-profit are in place (bracket). */
  brokerBracketDetected: boolean;
  /** True if the DB tracked stopOrderId appears in broker open orders and is active. */
  trackedStopConfirmed: boolean;
  /** Broker order ID of the confirmed active stop (may differ from DB tracked id). */
  activeStopOrderId?: string;
  /** Broker order ID of the confirmed active take-profit, if found. */
  activeTakeProfitOrderId?: string;

  // ── DB state snapshot (diagnostics only) ────────────────────────
  stopOrderIdPresent: boolean;
  takeProfitOrderIdPresent: boolean;
  /**
   * Raw historical protectionStatus from the trade DB record.
   * FOR DIAGNOSTICS ONLY — does not affect isCurrentlyProtected.
   */
  historicalProtectionStatus?: string;

  // ── Primary determination ────────────────────────────────────────
  /**
   * AUTHORITATIVE RESULT: is this trade currently protected?
   * Driven exclusively by broker truth.  Stale DB values are irrelevant.
   */
  isCurrentlyProtected: boolean;
  /** Human-readable summary of why the determination was made. */
  reason: string;

  // ── Auto-heal guidance ───────────────────────────────────────────
  /** True when position exists but no stop is found — repair should be attempted. */
  shouldRepair: boolean;
  /**
   * True when: position exists, stop is missing, AND the previous attempt field
   * indicates repair already failed — caller may decide to flatten instead.
   * Only set when opts.allowFlattenIfPreviousRepairFailed = true.
   */
  shouldFlatten: boolean;

  // ── Emergency flatten lifecycle (when shouldFlatten or repair is already underway) ─
  /**
   * True if there is an active market close order on the closing side.
   * When true, callers MUST NOT submit another close order (prevents double-ordering).
   */
  activeCloseOrderDetected: boolean;
  /** The order ID of the active emergency close order, if found. */
  activeCloseOrderId?: string;
  /** Alpaca status of the active emergency close order (e.g. partially_filled, new). */
  activeCloseOrderStatus?: string;
  /** Number of shares that have already filled in the close order. */
  closeOrderFilledQty: number;
  /** Current broker position qty (absolute value). 0 if no position. */
  brokerPositionQty: number;
  /**
   * Derived flatten lifecycle state for diagnostics.
   * "none"                    — not in flatten mode (position is protected or no position)
   * "FLATTEN_IN_PROGRESS"     — close order active and working
   * "FLATTEN_PARTIALLY_FILLED" — close order partially filled, residual remains
   * "EMERGENCY_EXIT_COMPLETE" — position is flat (qty = 0)
   */
  flattenLifecycleState: "none" | "FLATTEN_IN_PROGRESS" | "FLATTEN_PARTIALLY_FILLED" | "EMERGENCY_EXIT_COMPLETE";
};

// ─── Core function ───────────────────────────────────────────────────────────

/**
 * Evaluate whether a trade is CURRENTLY protected by an active stop at the broker.
 *
 * @param trade           Trade record (ticker/symbol, side, stopOrderId…).
 * @param brokerPositions Live broker positions from fetchBrokerTruth().
 * @param brokerOrders    Live broker open orders from fetchBrokerTruth().
 * @param opts.allowFlattenIfPreviousRepairFailed  Set true to make shouldFlatten=true
 *                        when the trade's protectionStatus indicates a prior repair failure.
 */
export function evaluateTradeProtectionNow(
  trade: Record<string, any>,
  brokerPositions: ProtTruthPosition[],
  brokerOrders: ProtTruthOrder[],
  opts: { allowFlattenIfPreviousRepairFailed?: boolean } = {},
): TradeProtectionNow {
  const sym = String(trade?.symbol ?? trade?.ticker ?? "").toUpperCase().trim();
  const side = String(trade?.side ?? "LONG").toUpperCase().trim();
  const stopOrderIdDB = trade?.stopOrderId ?? trade?.alpacaStopOrderId ?? null;
  const takeProfitOrderIdDB = trade?.takeProfitOrderId ?? trade?.alpacaTakeProfitOrderId ?? null;
  const historicalProtectionStatus: string | undefined = trade?.protectionStatus ?? undefined;

  // ── 1. Does a live broker position exist? ────────────────────────────────
  const brokerPos = brokerPositions.find(
    (p) => String(p.symbol ?? "").toUpperCase() === sym && Math.abs(Number(p.qty)) > 0,
  );
  const brokerPositionExists = !!brokerPos;

  if (!brokerPositionExists) {
    return {
      tradeId: String(trade?.id ?? ""),
      symbol: sym,
      brokerPositionExists: false,
      brokerStopDetected: false,
      brokerTakeProfitDetected: false,
      brokerBracketDetected: false,
      trackedStopConfirmed: false,
      stopOrderIdPresent: !!stopOrderIdDB,
      takeProfitOrderIdPresent: !!takeProfitOrderIdDB,
      isCurrentlyProtected: false,
      reason: "no_broker_position",
      shouldRepair: false,
      shouldFlatten: false,
      activeCloseOrderDetected: false,
      closeOrderFilledQty: 0,
      brokerPositionQty: 0,
      flattenLifecycleState: "EMERGENCY_EXIT_COMPLETE",
      historicalProtectionStatus,
    };
  }

  // ── 2. Determine the expected protective order side ──────────────────────
  // A LONG position is protected by a *sell* stop; SHORT by a *buy* stop.
  const expectedStopSide = side === "SHORT" ? "buy" : "sell";

  // ── 3. Filter orders to this symbol ────────────────────────────────────
  const symbolOrders = brokerOrders.filter(
    (o) => String(o.symbol ?? "").toUpperCase() === sym,
  );

  // ── 4. Scan for an active protective stop (side-matched) ─────────────
  let brokerStopDetected = false;
  let trackedStopConfirmed = false;
  let activeStopOrderId: string | undefined;

  for (const order of symbolOrders) {
    const orderType = String(order.type ?? "").toLowerCase();
    const orderStatus = String(order.status ?? "").toLowerCase();
    const orderSide = String(order.side ?? "").toLowerCase();

    if (!STOP_LIKE_ORDER_TYPES.has(orderType)) continue;
    if (!ACTIVE_ORDER_STATUSES.has(orderStatus)) continue;
    if (orderSide !== expectedStopSide) continue;

    brokerStopDetected = true;
    activeStopOrderId = order.id;

    if (stopOrderIdDB && order.id === String(stopOrderIdDB)) {
      trackedStopConfirmed = true;
    }
    break; // First match is sufficient
  }

  // ── 5. Fallback: check tracked stopOrderId directly (side-agnostic) ──
  // Handles edge cases: side recorded differently in DB vs broker, or old data.
  if (!brokerStopDetected && stopOrderIdDB) {
    const tracked = symbolOrders.find((o) => o.id === String(stopOrderIdDB));
    if (tracked) {
      const orderType = String(tracked.type ?? "").toLowerCase();
      const orderStatus = String(tracked.status ?? "").toLowerCase();
      if (ACTIVE_ORDER_STATUSES.has(orderStatus) && STOP_LIKE_ORDER_TYPES.has(orderType)) {
        brokerStopDetected = true;
        trackedStopConfirmed = true;
        activeStopOrderId = tracked.id;
        console.log(
          "[protection-truth] tracked stop confirmed via direct ID match (side mismatch tolerated)",
          { symbol: sym, stopOrderId: activeStopOrderId },
        );
      }
    }
  }

  // ── 6. Scan for active take-profit (limit on the close side) ─────────
  let brokerTakeProfitDetected = false;
  let activeTakeProfitOrderId: string | undefined;

  for (const order of symbolOrders) {
    const orderType = String(order.type ?? "").toLowerCase();
    const orderStatus = String(order.status ?? "").toLowerCase();
    const orderSide = String(order.side ?? "").toLowerCase();

    if (!TAKE_PROFIT_ORDER_TYPES.has(orderType)) continue;
    if (!ACTIVE_ORDER_STATUSES.has(orderStatus)) continue;
    if (orderSide !== expectedStopSide) continue; // same close-side as stop

    brokerTakeProfitDetected = true;
    activeTakeProfitOrderId = order.id;

    if (takeProfitOrderIdDB && order.id === String(takeProfitOrderIdDB)) {
      // Tracked take-profit confirmed
    }
    break;
  }

  const brokerBracketDetected = brokerStopDetected && brokerTakeProfitDetected;

  // ── 7. PROTECTION DECISION — broker truth is primary ────────────────
  // If broker has a valid active stop, the trade IS protected regardless of any
  // historical protectionStatus field (e.g. REPAIR_FAILED is stale metadata).
  const isCurrentlyProtected = brokerStopDetected;

  // ── 8. Build reason string ────────────────────────────────────────
  let reason: string;
  if (brokerBracketDetected) {
    reason = trackedStopConfirmed
      ? "broker_bracket_stop_tp_tracked_confirmed"
      : "broker_bracket_stop_tp_detected";
  } else if (brokerStopDetected) {
    reason = trackedStopConfirmed
      ? "broker_stop_tracked_confirmed"
      : "broker_stop_detected_by_scan";
  } else if (historicalProtectionStatus === "REPAIR_FAILED" || historicalProtectionStatus === "STOP_REPAIR_FAILED") {
    reason = "no_stop_at_broker_prior_repair_failed";
  } else {
    reason = "no_stop_at_broker";
  }

  // ── 9. Log stale-override scenarios ──────────────────────────────
  if (
    isCurrentlyProtected &&
    (historicalProtectionStatus === "REPAIR_FAILED" ||
      historicalProtectionStatus === "STOP_REPAIR_FAILED" ||
      historicalProtectionStatus === "MISSING_STOP")
  ) {
    console.log(
      "[protection-truth] stale DB status OVERRIDDEN: broker confirms active stop — trade IS protected",
      {
        symbol: sym,
        tradeId: trade?.id,
        historicalProtectionStatus,
        activeStopOrderId,
        reason,
      },
    );
  } else if (!isCurrentlyProtected && historicalProtectionStatus === "VERIFIED") {
    console.warn(
      "[protection-truth] protection LOST: DB shows VERIFIED but broker has no active stop",
      { symbol: sym, tradeId: trade?.id },
    );
  }

  // ── 10. Auto-heal guidance ────────────────────────────────────────
  const shouldRepair = !isCurrentlyProtected; // position exists (confirmed above)
  const prevRepairFailed =
    historicalProtectionStatus === "REPAIR_FAILED" ||
    historicalProtectionStatus === "STOP_REPAIR_FAILED";
  const shouldFlatten =
    shouldRepair && prevRepairFailed && (opts.allowFlattenIfPreviousRepairFailed ?? false);

  // ── 11. Emergency flatten close-order detection ───────────────────
  // Detect any active market close order (sell for LONG, buy for SHORT).
  // When present, callers MUST NOT submit another flatten order.
  const expectedCloseSide = side === "SHORT" ? "buy" : "sell";
  const ACTIVE_CLOSE_ORDER_STATUSES = new Set([
    "new", "accepted", "pending_new", "pending_replace",
    "accepted_for_bidding", "partially_filled", "held",
  ]);

  let activeCloseOrderDetected = false;
  let activeCloseOrderId: string | undefined;
  let activeCloseOrderStatus: string | undefined;
  let closeOrderFilledQty = 0;

  for (const order of symbolOrders) {
    const orderSide = String(order.side ?? "").toLowerCase();
    const orderType = String(order.type ?? "").toLowerCase();
    const orderStatus = String(order.status ?? "").toLowerCase();
    if (
      orderSide === expectedCloseSide &&
      (orderType === "market") &&
      ACTIVE_CLOSE_ORDER_STATUSES.has(orderStatus)
    ) {
      activeCloseOrderDetected = true;
      activeCloseOrderId = order.id;
      activeCloseOrderStatus = orderStatus;
      closeOrderFilledQty = Math.abs(Number(order.filled_qty ?? order.qty_filled ?? 0));
      break;
    }
  }

  // ── 12. Derive flatten lifecycle state ────────────────────────────
  const brokerPositionQty = Math.abs(Number(brokerPos?.qty ?? 0));
  let flattenLifecycleState: TradeProtectionNow["flattenLifecycleState"] = "none";
  if (!brokerPositionExists) {
    flattenLifecycleState = "EMERGENCY_EXIT_COMPLETE";
  } else if (activeCloseOrderDetected) {
    flattenLifecycleState = activeCloseOrderStatus === "partially_filled"
      ? "FLATTEN_PARTIALLY_FILLED"
      : "FLATTEN_IN_PROGRESS";
  }

  return {
    tradeId: String(trade?.id ?? ""),
    symbol: sym,
    brokerPositionExists,
    brokerStopDetected,
    brokerTakeProfitDetected,
    brokerBracketDetected,
    trackedStopConfirmed,
    stopOrderIdPresent: !!stopOrderIdDB,
    takeProfitOrderIdPresent: !!takeProfitOrderIdDB,
    activeStopOrderId,
    activeTakeProfitOrderId,
    isCurrentlyProtected,
    reason,
    shouldRepair,
    shouldFlatten,
    historicalProtectionStatus,
    activeCloseOrderDetected,
    activeCloseOrderId,
    activeCloseOrderStatus,
    closeOrderFilledQty,
    brokerPositionQty,
    flattenLifecycleState,
  };
}
