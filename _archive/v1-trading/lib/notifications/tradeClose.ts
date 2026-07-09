/**
 * Trade close notification formatting helpers
 * 
 * Usage example:
 * 
 * ```typescript
 * import { notify } from "@/lib/notifications/notify";
 * import { buildTradeClosedPayload } from "@/lib/notifications/tradeClose";
 * 
 * const trade = {
 *   id: "trade-123",
 *   ticker: "AAPL",
 *   closeReason: "stop_hit",
 *   realizedR: -0.52,
 *   realizedPnL: -183.22,
 *   entryPrice: 150.00,
 *   closePrice: 148.00,
 * };
 * 
 * const { title, message } = buildTradeClosedPayload(trade);
 * 
 * await notify({
 *   type: "TRADE_CLOSED",
 *   tradeId: trade.id,
 *   ticker: trade.ticker,
 *   paper: true,  // Set to true for paper trading
 *   title,
 *   message,
 *   tier: "B",
 *   dedupeKey: `notify:dedupe:v1:trade_closed:${trade.id}`,
 *   dedupeTtlSec: 86400,
 * });
 * ```
 * 
 * This will send a Pushover notification:
 * Title: "SOLD: AAPL (stop_hit)"
 * Message: "AAPL | closed -0.52R | -$183.22 | entry $150.00 → exit $148.00"
 * 
 * Test endpoint:
 * POST /api/maintenance/notify-trade-closed-test?tradeId=<id>
 *   -H "x-cron-token: $CRON_TOKEN"
 */

export type TradeClosePayload = {
  title: string;
  message: string;
};

/**
 * Format a dollar amount with sign (+/-) and 2 decimal places
 * Examples: +$123.45, -$56.78, $0.00
 */
export function formatSignedDollars(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return "$0.00";
  
  const absAmount = Math.abs(amount);
  const formatted = `$${absAmount.toFixed(2)}`;
  
  if (amount > 0) return `+${formatted}`;
  if (amount < 0) return `-${formatted}`;
  return formatted;
}

/**
 * Format an R-multiple with sign (+/-)
 * Examples: +1.25R, -0.52R, 0.00R
 */
export function formatSignedR(r: number | null | undefined): string {
  if (r == null || !Number.isFinite(r)) return "0.00R";
  
  const absR = Math.abs(r);
  const formatted = `${absR.toFixed(2)}R`;
  
  if (r > 0) return `+${formatted}`;
  if (r < 0) return `-${formatted}`;
  return formatted;
}

/**
 * Build a trade close notification payload
 * 
 * Example title: "SOLD: AAPL (stop_hit)"
 * Example message: "AAPL closed -0.52R | -$183.22 | entry $150.00 → exit $148.00"
 */
export function buildTradeClosedPayload(trade: any): TradeClosePayload {
  const ticker = trade.ticker || "UNKNOWN";
  const closeReason = trade.closeReason || "unknown";
  const realizedR = trade.realizedR;
  const realizedPnL = trade.realizedPnL;
  const entryPrice = trade.entryPrice;
  const closePrice = trade.closePrice;
  
  // Title: SOLD: ${ticker} (${closeReason})
  const title = `SOLD: ${ticker} (${closeReason})`;
  
  // Message parts
  const parts: string[] = [];
  
  // Always include ticker
  parts.push(ticker);
  
  // Add R and P&L if available
  if (realizedR != null && Number.isFinite(realizedR)) {
    parts.push(`closed ${formatSignedR(realizedR)}`);
  }
  
  if (realizedPnL != null && Number.isFinite(realizedPnL)) {
    parts.push(`${formatSignedDollars(realizedPnL)}`);
  }
  
  // Add entry → exit if both are available
  if (
    entryPrice != null &&
    Number.isFinite(entryPrice) &&
    closePrice != null &&
    Number.isFinite(closePrice)
  ) {
    parts.push(`entry $${entryPrice.toFixed(2)} → exit $${closePrice.toFixed(2)}`);
  }
  
  const message = parts.join(" | ");
  
  return { title, message };
}
