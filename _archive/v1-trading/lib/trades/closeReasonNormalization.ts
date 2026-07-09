/**
 * Defensive normalization for CLOSED trades:
 * ensures closeReason is always set before writing.
 */

export function ensureCloseReason(trade: any): any {
  const status = String(trade?.status || "").toUpperCase();
  if (status !== "CLOSED") return trade;

  const hasReason = Boolean(
    typeof trade?.closeReason === "string" && trade.closeReason.trim()
  );

  if (hasReason) return trade;

  // Infer fallback closeReason from available metadata
  let closeReason = "closed_no_reason";

  const alpacaStatus = String(trade?.alpacaStatus || "").toLowerCase();
  const brokerStatus = String(trade?.brokerStatus || "").toLowerCase();
  const hasRealized = typeof trade?.realizedPnL === "number";

  // Try to infer from status fields
  if (alpacaStatus === "filled" || brokerStatus === "filled") {
    closeReason = "exit_fill";
  } else if (alpacaStatus === "canceled" || brokerStatus === "canceled") {
    closeReason = "canceled_before_fill";
  } else if (alpacaStatus.includes("stop") || brokerStatus.includes("stop")) {
    closeReason = "stop_hit";
  } else if (
    alpacaStatus.includes("profit") ||
    brokerStatus.includes("profit")
  ) {
    closeReason = "take_profit_hit";
  } else if (hasRealized && trade.realizedPnL > 0) {
    closeReason = "exit_fill";
  } else if (hasRealized && trade.realizedPnL < 0) {
    closeReason = "stop_hit";
  } else if (trade?.error) {
    closeReason = "reconciled_not_in_alpaca";
  }

  return {
    ...trade,
    closeReason,
  };
}

export function normalizeClosedTrades(trades: any[]): any[] {
  return trades.map(ensureCloseReason);
}
