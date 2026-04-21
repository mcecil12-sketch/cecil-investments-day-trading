import { readTrades, writeTrades } from "@/lib/tradesStore";
import { fetchBrokerTruth } from "@/lib/broker/truth";
import { verifyStopAtBroker } from "@/lib/risk/stop-verification";
import { recoverUnprotectedTrade } from "@/lib/risk/stop-verification";
import { forceFlattenPosition } from "@/lib/broker/forceFlattenPosition";
import { saveCriticalTask } from "@/lib/redis";

export type TradeRecoveryDiagnostic = {
  tradeId: string;
  symbol: string;
  stopRepairAttempted: boolean;
  stopRepairSucceeded: boolean;
  flattenAttempted: boolean;
  flattenSucceeded: boolean;
  cancelOrdersAttempted: boolean;
  cancelOrdersSucceeded: boolean;
  brokerPositionExistsAfter: boolean | null;
  finalResolution: "protected" | "flattened" | "failed";
  stopOrderId?: string | null;
  error?: string;
};

export type ProtectionRecoveryResult = {
  repairAttempted: boolean;
  repairSucceeded: boolean;
  flattenTriggered: boolean;
  affectedTradeIds: string[];
  affectedSymbols: string[];
  /** "protected" | "flattened" | "partial" | "failed" | "none" */
  resolutionStatus: string;
  /** true ONLY when a broker position still lacks a stop after all recovery steps */
  blockerStillActive: boolean;
  details: TradeRecoveryDiagnostic[];
};

export async function recoverUnprotectedTrades(): Promise<ProtectionRecoveryResult> {
  const trades = await readTrades();
  const brokerTruth = await fetchBrokerTruth();
  const openPositions = Array.isArray(brokerTruth.positions) ? brokerTruth.positions : [];

  let repairAttempted = false;
  let repairSucceeded = false;
  let flattenTriggered = false;
  const affectedTradeIds: string[] = [];
  const affectedSymbols: string[] = [];
  const details: TradeRecoveryDiagnostic[] = [];

  for (const trade of trades) {
    if (String(trade.status) !== "OPEN" || !trade.ticker) continue;
    const symbol = String(trade.ticker).toUpperCase();

    // Only act on trades that have a real broker position
    const brokerPos = openPositions.find(
      (p: any) => String(p.symbol).toUpperCase() === symbol && Math.abs(Number(p.qty)) > 0
    );
    if (!brokerPos) continue;

    // Check whether a protective stop already exists
    const stopOrderId = trade.stopOrderId || trade.alpacaStopOrderId || null;
    const verify = await verifyStopAtBroker({ symbol, side: trade.side, stopOrderId, brokerTruth });
    if (verify.verified) continue;

    // ── Unprotected trade found ──────────────────────────────────
    repairAttempted = true;
    affectedTradeIds.push(trade.id);
    affectedSymbols.push(symbol);

    const diag: TradeRecoveryDiagnostic = {
      tradeId: trade.id,
      symbol,
      stopRepairAttempted: false,
      stopRepairSucceeded: false,
      flattenAttempted: false,
      flattenSucceeded: false,
      cancelOrdersAttempted: false,
      cancelOrdersSucceeded: false,
      brokerPositionExistsAfter: null,
      finalResolution: "failed",
    };

    // ── A. Attempt stop repair directly via broker ───────────────
    diag.stopRepairAttempted = true;
    const avgEntryPrice = Number(brokerPos.avg_entry_price) || 0;
    const repair = await recoverUnprotectedTrade({
      symbol,
      side: trade.side,
      qty: Number(brokerPos.qty),
      avgEntryPrice,
      preferredStopPrice: trade.stopPrice,
      tradeId: trade.id,
    });

    if (repair.ok && repair.stopOrderId) {
      // Verify the stop is active at broker
      const verify2 = await verifyStopAtBroker({
        symbol,
        side: trade.side,
        stopOrderId: repair.stopOrderId,
      });
      if (verify2.verified) {
        diag.stopRepairSucceeded = true;
        diag.brokerPositionExistsAfter = true; // position still open, now protected
        diag.finalResolution = "protected";
        diag.stopOrderId = repair.stopOrderId;
        repairSucceeded = true;
        trade.stopOrderId = repair.stopOrderId;
        trade.protectionStatus = "RECOVERED";
        trade.updatedAt = new Date().toISOString();
        details.push(diag);
        continue;
      }
    }

    // ── B. Repair failed → force flatten (cancel orders first) ──
    flattenTriggered = true;
    diag.flattenAttempted = true;
    diag.error = repair.reason ?? repair.detail;

    const flatten = await forceFlattenPosition(symbol);
    diag.cancelOrdersAttempted = flatten.diagnostics.cancelOrdersAttempted;
    diag.cancelOrdersSucceeded = flatten.diagnostics.cancelOrdersSucceeded;
    diag.flattenSucceeded = flatten.ok;
    diag.brokerPositionExistsAfter = flatten.diagnostics.brokerPositionExistsAfter;

    if (flatten.ok) {
      // Broker confirmed position is gone — safe to mark as FLATTENED
      diag.finalResolution = "flattened";
      trade.status = "ERROR";
      trade.protectionStatus = "FLATTENED";
      trade.updatedAt = new Date().toISOString();
      await saveCriticalTask({
        incidentCode: "STOP_REPAIR_FAILED",
        symbol,
        severity: "CRITICAL",
        detail: `Stop repair failed; position force-flattened. tradeId=${trade.id} repairError=${diag.error ?? "unknown"}`,
      }).catch(() => {});
    } else {
      // Flatten also failed — CRITICAL. Do NOT mark trade as resolved.
      diag.finalResolution = "failed";
      diag.error = (diag.error ? diag.error + "; " : "") + `flatten error: ${flatten.error ?? "unknown"}`;
      // Do NOT change trade.status — position still exists, keep it OPEN
      // so it stays in scope for the next enforcement cycle
      console.error("[protection-recover] CRITICAL: flatten failed", {
        symbol,
        tradeId: trade.id,
        flattenStep: flatten.step,
        flattenError: flatten.error,
      });
      await saveCriticalTask({
        incidentCode: "FLATTEN_FAILED",
        symbol,
        severity: "CRITICAL",
        detail: `Stop repair AND flatten both failed. tradeId=${trade.id} lastError=${flatten.error ?? "unknown"}`,
      }).catch(() => {});
    }

    details.push(diag);
  }

  await writeTrades(trades);

  // ── Determine if any blocker is still active (broker-truth based) ──
  // Re-fetch broker state after all recovery attempts
  const brokerTruth2 = await fetchBrokerTruth();
  const openPositions2 = Array.isArray(brokerTruth2.positions) ? brokerTruth2.positions : [];
  const openOrders2 = Array.isArray(brokerTruth2.openOrders) ? brokerTruth2.openOrders : [];

  // A blocker is active if ANY broker position lacks a matching protective stop
  const blockerStillActive = openPositions2.some((p: any) => {
    const sym = String(p.symbol).toUpperCase();
    if (Math.abs(Number(p.qty)) === 0) return false;
    const hasStop = openOrders2.some(
      (o: any) =>
        String(o.symbol).toUpperCase() === sym &&
        (String(o.type || "").toLowerCase() === "stop" ||
          String(o.type || "").toLowerCase() === "stop_limit") &&
        ["new", "accepted", "pending", "held"].includes(
          String(o.status || "").toLowerCase()
        )
    );
    return !hasStop;
  });

  // Compute overall resolution status
  const criticalFailures = details.filter((d) => d.finalResolution === "failed").length;
  const flattened = details.filter((d) => d.finalResolution === "flattened").length;
  const protected_ = details.filter((d) => d.finalResolution === "protected").length;

  let resolutionStatus: string;
  if (details.length === 0) {
    resolutionStatus = "none";
  } else if (criticalFailures > 0) {
    resolutionStatus = "failed";
  } else if (protected_ > 0 && flattened > 0) {
    resolutionStatus = "partial";
  } else if (protected_ > 0) {
    resolutionStatus = "protected";
  } else if (flattened > 0) {
    // Only report "flattened" when broker confirmed all positions are gone
    resolutionStatus = "flattened";
  } else {
    resolutionStatus = "none";
  }

  return {
    repairAttempted,
    repairSucceeded,
    flattenTriggered,
    affectedTradeIds,
    affectedSymbols,
    resolutionStatus,
    blockerStillActive,
    details,
  };
}
