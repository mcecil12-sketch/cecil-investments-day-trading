import { readTrades, writeTrades } from "@/lib/tradesStore";
import { fetchBrokerTruth } from "@/lib/broker/truth";
import { verifyStopAtBroker } from "@/lib/risk/stop-verification";
import { recoverUnprotectedTrade, flattenUnprotectedPosition } from "@/lib/risk/stop-verification";

export type ProtectionRecoveryResult = {
  repairAttempted: boolean;
  repairSucceeded: boolean;
  flattenTriggered: boolean;
  affectedTradeIds: string[];
  affectedSymbols: string[];
  resolutionStatus: string;
  blockerStillActive: boolean;
  details: any[];
};

export async function recoverUnprotectedTrades(): Promise<ProtectionRecoveryResult> {
  const trades = await readTrades();
  const brokerTruth = await fetchBrokerTruth();
  const openPositions = Array.isArray(brokerTruth.positions) ? brokerTruth.positions : [];
  const openOrders = Array.isArray(brokerTruth.openOrders) ? brokerTruth.openOrders : [];

  let repairAttempted = false;
  let repairSucceeded = false;
  let flattenTriggered = false;
  let blockerStillActive = false;
  const affectedTradeIds: string[] = [];
  const affectedSymbols: string[] = [];
  const details: any[] = [];

  for (const trade of trades) {
    if (String(trade.status) !== "OPEN" || !trade.ticker) continue;
    const symbol = String(trade.ticker).toUpperCase();
    const brokerPos = openPositions.find((p: any) => String(p.symbol).toUpperCase() === symbol && Math.abs(p.qty) > 0);
    if (!brokerPos) continue;
    // Check for active stop
    const stopOrderId = trade.stopOrderId || trade.alpacaStopOrderId || null;
    const verify = await verifyStopAtBroker({ symbol, side: trade.side, stopOrderId, brokerTruth });
    if (verify.verified) continue;
    // Unprotected trade found
    repairAttempted = true;
    affectedTradeIds.push(trade.id);
    affectedSymbols.push(symbol);
    // Attempt repair
    const avgEntryPrice = Number(brokerPos.avg_entry_price) || 0;
    const repair = await recoverUnprotectedTrade({
      symbol,
      side: trade.side,
      qty: brokerPos.qty,
      avgEntryPrice,
      preferredStopPrice: trade.stopPrice,
      tradeId: trade.id,
    });
    if (repair.ok && repair.stopOrderId) {
      // Verify again
      const verify2 = await verifyStopAtBroker({ symbol, side: trade.side, stopOrderId: repair.stopOrderId });
      if (verify2.verified) {
        repairSucceeded = true;
        trade.stopOrderId = repair.stopOrderId;
        trade.protectionStatus = "RECOVERED";
        trade.updatedAt = new Date().toISOString();
        details.push({ tradeId: trade.id, symbol, action: "repair_succeeded", stopOrderId: repair.stopOrderId });
        continue;
      }
    }
    // If repair failed, flatten
    flattenTriggered = true;
    const flatten = await flattenUnprotectedPosition({ symbol, tradeId: trade.id, reason: "protection_repair_failed" });
    trade.status = "ERROR";
    trade.protectionStatus = "FLATTENED";
    trade.updatedAt = new Date().toISOString();
    details.push({ tradeId: trade.id, symbol, action: "flatten_triggered", flattenResult: flatten });
  }
  await writeTrades(trades);
  // Re-check if any blockers remain
  const brokerTruth2 = await fetchBrokerTruth();
  const openPositions2 = Array.isArray(brokerTruth2.positions) ? brokerTruth2.positions : [];
  blockerStillActive = openPositions2.some((p: any) => {
    const sym = String(p.symbol).toUpperCase();
    return trades.some((t: any) => t.status === "OPEN" && String(t.ticker).toUpperCase() === sym);
  });
  return {
    repairAttempted,
    repairSucceeded,
    flattenTriggered,
    affectedTradeIds,
    affectedSymbols,
    resolutionStatus: flattenTriggered ? (repairSucceeded ? "partial" : "flattened") : (repairSucceeded ? "repaired" : "none"),
    blockerStillActive,
    details,
  };
}
