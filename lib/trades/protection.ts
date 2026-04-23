export type ProtectionStatus =
  | "VERIFIED"
  | "MISSING_STOP"
  | "STOP_EXPIRED"
  | "STOP_CANCELED"
  | "REPAIRING"
  | "REPAIRED"
  | "REPAIR_FAILED"
  | "RECOVERED"
  | "FLATTENED"
  // ── Emergency flatten lifecycle states ──────────────────────────────────
  /** Repair failed; flatten not yet started — position is unprotected. */
  | "FLATTEN_PENDING"
  /** Emergency close order submitted and active at broker. */
  | "FLATTEN_IN_PROGRESS"
  /** Emergency close order partially filled; residual exposure remains. */
  | "FLATTEN_PARTIALLY_FILLED"
  /** Emergency close order failed/rejected; position still unprotected. */
  | "FLATTEN_FAILED"
  /** Position confirmed flat by broker — emergency exit complete. */
  | "EMERGENCY_EXIT_COMPLETE";

export const UNPROTECTED_PROTECTION_STATUSES = new Set<ProtectionStatus>([
  "MISSING_STOP",
  "STOP_EXPIRED",
  "STOP_CANCELED",
  "REPAIRING",
  "REPAIR_FAILED",
  // In-flight flatten states: position still exists, execution must stay blocked
  "FLATTEN_PENDING",
  "FLATTEN_IN_PROGRESS",
  "FLATTEN_PARTIALLY_FILLED",
  "FLATTEN_FAILED",
]);

export type ProtectionIssueCode =
  | "missing_protective_stop_order"
  | "tracked_stop_not_found_open"
  | "stop_expired"
  | "stop_canceled"
  | "stop_rejected"
  | "stop_invalid_status"
  | "missing_broker_position"
  | "stop_side_mismatch"
  | "stop_symbol_mismatch"
  | "stop_qty_invalid"
  | "stop_price_invalid"
  | "broker_order_lookup_failed"
  | "repair_submit_failed"
  | "repair_verify_failed"
  | "flatten_submit_failed";

export type ProtectionTrackedFields = {
  protectionStatus?: ProtectionStatus;
  protectionVerifiedAt?: string;
  protectionIssue?: string;
  lastProtectionCheckAt?: string;
};

export type ProtectionClassification = {
  status: ProtectionStatus;
  issue?: ProtectionIssueCode;
  issueDetail?: string;
  activeStopOrderId?: string;
  activeStopPrice?: number;
};

type BrokerOrderLike = {
  id?: string;
  symbol?: string;
  side?: string;
  type?: string;
  status?: string;
  stop_price?: number | string;
};

const OPEN_ORDER_STATUSES = new Set([
  "new",
  "accepted",
  "pending_new",
  "pending_replace",
  "accepted_for_bidding",
  "partially_filled",
  "held",
]);

const CANCELED_ORDER_STATUSES = new Set(["canceled", "cancelled", "replaced", "stopped"]);
const EXPIRED_ORDER_STATUSES = new Set(["expired", "done_for_day"]);
const STOP_ORDER_TYPES = new Set(["stop", "stop_limit", "trailing_stop"]);

function up(value: unknown): string {
  return String(value || "").toUpperCase();
}

function lower(value: unknown): string {
  return String(value || "").toLowerCase();
}

function num(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeTicker(value: unknown): string {
  return up(value);
}

export function normalizeTradeSide(value: unknown): "LONG" | "SHORT" | null {
  const side = up(value);
  if (side === "LONG") return "LONG";
  if (side === "SHORT") return "SHORT";
  return null;
}

export function protectiveOrderSideForTrade(side: "LONG" | "SHORT"): "sell" | "buy" {
  return side === "SHORT" ? "buy" : "sell";
}

export function isOpenTradeStatus(status: unknown): boolean {
  const value = up(status);
  return (
    value === "OPEN" ||
    value === "PARTIAL" ||
    value === "PENDING" ||
    value === "AUTO_OPEN" ||
    value === "MANUAL" ||
    value === "ACTIVE"
  );
}

export function isOpenOrderStatus(status: unknown): boolean {
  return OPEN_ORDER_STATUSES.has(lower(status));
}

export function classifyOrderTerminalStatus(
  status: unknown
): "EXPIRED" | "CANCELED" | "OTHER" | null {
  const normalized = lower(status);
  if (!normalized) return null;
  if (EXPIRED_ORDER_STATUSES.has(normalized)) return "EXPIRED";
  if (CANCELED_ORDER_STATUSES.has(normalized)) return "CANCELED";
  return "OTHER";
}

export function classifyStopStatus(
  status: string | null | undefined
): "ACTIVE" | "EXPIRED" | "CANCELED" | "FILLED" | "OTHER" {
  const terminal = classifyOrderTerminalStatus(status);
  if (terminal === "EXPIRED") return "EXPIRED";
  if (terminal === "CANCELED") return "CANCELED";
  const normalized = lower(status);
  if (normalized === "filled") return "FILLED";
  if (isOpenOrderStatus(normalized)) return "ACTIVE";
  return "OTHER";
}

function isCloseSide(orderSide: unknown, tradeSide: unknown): boolean {
  const side = lower(orderSide);
  const trade = up(tradeSide);
  if (trade === "SHORT") return side === "buy";
  return side === "sell";
}

export function isStopLikeOrder(order: BrokerOrderLike): boolean {
  const type = lower(order?.type);
  if (STOP_ORDER_TYPES.has(type)) return true;
  const stopPrice = num(order?.stop_price);
  return stopPrice != null && stopPrice > 0;
}

export function findProtectiveStopOrder(args: {
  ticker: string;
  tradeSide: "LONG" | "SHORT";
  openOrders: BrokerOrderLike[];
}): { id: string; stopPrice: number | null } | null {
  const ticker = normalizeTicker(args.ticker);
  const expectedSide = protectiveOrderSideForTrade(args.tradeSide);
  for (const order of Array.isArray(args.openOrders) ? args.openOrders : []) {
    if (!order) continue;
    const symbol = normalizeTicker(order.symbol);
    if (!symbol || symbol !== ticker) continue;
    if (!isStopLikeOrder(order)) continue;
    if (!isOpenOrderStatus(order.status)) continue;
    const side = lower(order.side);
    if (side !== expectedSide) continue;
    const id = String(order.id || "");
    if (!id) continue;
    return {
      id,
      stopPrice: num(order.stop_price),
    };
  }
  return null;
}

export function findActiveProtectiveStopOrder(args: {
  tradeSide?: string;
  symbol?: string;
  openOrders?: BrokerOrderLike[];
}) {
  const symbol = up(args.symbol);
  const orders = Array.isArray(args.openOrders) ? args.openOrders : [];

  for (const order of orders) {
    if (up(order?.symbol) !== symbol) continue;
    if (!isStopLikeOrder(order)) continue;
    if (!isCloseSide(order?.side, args.tradeSide)) continue;
    if (classifyStopStatus(order?.status) !== "ACTIVE") continue;
    return order;
  }
  return null;
}
