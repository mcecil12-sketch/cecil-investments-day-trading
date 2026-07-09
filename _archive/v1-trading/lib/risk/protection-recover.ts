import { readTrades, writeTrades } from "@/lib/tradesStore";
import { fetchBrokerTruth, clearBrokerTruthCache } from "@/lib/broker/truth";
import { verifyStopAtBroker } from "@/lib/risk/stop-verification";
import { recoverUnprotectedTrade } from "@/lib/risk/stop-verification";
import { saveCriticalTask } from "@/lib/redis";
import { evaluateTradeProtectionNow } from "@/lib/risk/protection-truth";
import {
  continueFlattenLifecycle,
  saveFlattenIncident,
  retireFlattenIncidents,
  type FlattenLifecycleState,
  type FlattenLifecycleDiagnostic,
} from "@/lib/risk/emergency-flatten-engine";

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
  finalResolution: "protected" | "flattened" | "flatten_in_progress" | "failed";
  stopOrderId?: string | null;
  error?: string;
  // ── Flatten lifecycle detail ─────────────────────────────────────────
  flattenState?: FlattenLifecycleState;
  flattenOrderId?: string;
  activeCloseOrderDetected?: boolean;
  activeCloseOrderStatus?: string;
  brokerPositionQty?: number;
  residualQty?: number;
};

export type ProtectionRecoveryResult = {
  repairAttempted: boolean;
  repairSucceeded: boolean;
  flattenTriggered: boolean;
  affectedTradeIds: string[];
  affectedSymbols: string[];
  /** "protected" | "flattened" | "flatten_in_progress" | "partial" | "failed" | "none" */
  resolutionStatus: string;
  /** true ONLY when a broker position still lacks a stop after all recovery steps */
  blockerStillActive: boolean;
  details: TradeRecoveryDiagnostic[];
  /** Structured flatten lifecycle diagnostics for each symbol being flattened */
  flattenDiagnostics: FlattenLifecycleDiagnostic[];
};

export async function recoverUnprotectedTrades(): Promise<ProtectionRecoveryResult> {
  const trades = await readTrades();
  // Force-refresh broker truth so we always evaluate against current state, not stale cache
  await clearBrokerTruthCache();
  const brokerTruth = await fetchBrokerTruth();
  const openPositions = Array.isArray(brokerTruth.positions) ? brokerTruth.positions : [];

  let repairAttempted = false;
  let repairSucceeded = false;
  let flattenTriggered = false;
  const affectedTradeIds: string[] = [];
  const affectedSymbols: string[] = [];
  const details: TradeRecoveryDiagnostic[] = [];
  const flattenDiagnostics: FlattenLifecycleDiagnostic[] = [];

  for (const trade of trades) {
    if (String(trade.status) !== "OPEN" || !trade.ticker) continue;
    const symbol = String(trade.ticker).toUpperCase();

    // Only act on trades that have a real broker position
    const brokerPos = openPositions.find(
      (p: any) => String(p.symbol).toUpperCase() === symbol && Math.abs(Number(p.qty)) > 0
    );
    if (!brokerPos) continue;

    // Check whether a protective stop currently exists at broker (broker truth is primary).
    // Using evaluateTradeProtectionNow ensures historical protectionStatus values like
    // REPAIR_FAILED never cause a false "unprotected" determination when the broker
    // already has a valid active stop in place (e.g. bracket leg that became active).
    const protNow = evaluateTradeProtectionNow(
      trade,
      openPositions,
      brokerTruth.openOrders || [],
    );

    if (protNow.isCurrentlyProtected) {
      console.log("[protection-recover] trade is currently protected — skipping", {
        symbol,
        tradeId: trade.id,
        reason: protNow.reason,
        activeStopOrderId: protNow.activeStopOrderId,
        historicalStatus: protNow.historicalProtectionStatus,
        trackedStopConfirmed: protNow.trackedStopConfirmed,
      });
      continue;
    }

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

    // ── B. Repair failed → emergency flatten lifecycle ───────────────
    // Use continueFlattenLifecycle which:
    //   - Checks for existing active close order (prevents duplicate submissions)
    //   - Handles partial fills as FLATTEN_IN_PROGRESS / FLATTEN_PARTIALLY_FILLED
    //   - Re-submits when close order is absent and position still exists
    //   - Detects ALREADY_FLAT for auto-retire
    flattenTriggered = true;
    diag.flattenAttempted = true;
    diag.error = repair.reason ?? repair.detail;

    const flattenResult = await continueFlattenLifecycle({
      symbol,
      tradeSide: trade.side ?? "LONG",
      tradeId: trade.id,
    });

    // Populate structured diagnostics
    diag.flattenState = flattenResult.state;
    diag.flattenOrderId = flattenResult.closeOrderId;
    diag.activeCloseOrderDetected = flattenResult.activeCloseOrderDetected;
    diag.activeCloseOrderStatus = flattenResult.activeCloseOrderStatus;
    diag.brokerPositionQty = flattenResult.brokerPositionQty;
    diag.residualQty = flattenResult.residualQty;
    diag.cancelOrdersAttempted = true; // continueFlattenLifecycle cancels conflicting orders
    diag.cancelOrdersSucceeded = flattenResult.ok;

    // Build a structured FlattenLifecycleDiagnostic for this trade
    flattenDiagnostics.push({
      blockerCode: flattenResult.state,
      tradeId: trade.id,
      symbol,
      recoveryState: flattenResult.state,
      brokerPositionQty: flattenResult.brokerPositionQty,
      activeCloseOrderDetected: flattenResult.activeCloseOrderDetected,
      activeCloseOrderId: flattenResult.activeCloseOrderId,
      activeCloseOrderStatus: flattenResult.activeCloseOrderStatus,
      residualQty: flattenResult.residualQty,
      repairAttempted: true,
      repairSucceeded: false,
      flattenAttempted: true,
      flattenOrderId: flattenResult.closeOrderId,
      flattenProgress: flattenResult.detail,
      nextAction: flattenResult.isFlat
        ? "blocker_retired_position_flat"
        : flattenResult.activeCloseOrderDetected
          ? "monitoring_close_order"
          : flattenResult.ok
            ? "monitoring_close_order"
            : "manual_intervention_required",
    });

    if (flattenResult.isFlat || flattenResult.state === "ALREADY_FLAT") {
      // Position confirmed flat — emergency exit complete
      diag.flattenSucceeded = true;
      diag.brokerPositionExistsAfter = false;
      diag.finalResolution = "flattened";
      trade.status = "ERROR";
      trade.protectionStatus = "EMERGENCY_EXIT_COMPLETE";
      trade.updatedAt = new Date().toISOString();
      // Auto-retire ALL flatten + stop-repair incidents for this symbol
      await retireFlattenIncidents(
        symbol,
        `emergency_exit_complete: position flat after flatten. tradeId=${trade.id}`,
      );
      console.log("[protection-recover] EMERGENCY_EXIT_COMPLETE: position flat", {
        symbol,
        tradeId: trade.id,
      });
    } else if (
      flattenResult.state === "FLATTEN_IN_PROGRESS" ||
      flattenResult.state === "FLATTEN_PARTIALLY_FILLED"
    ) {
      // Close order is active — track as in-progress (NOT a failure)
      diag.flattenSucceeded = false;
      diag.brokerPositionExistsAfter = true;
      diag.finalResolution = "flatten_in_progress";

      // Update trade protectionStatus to reflect real state
      trade.protectionStatus =
        flattenResult.state === "FLATTEN_PARTIALLY_FILLED"
          ? "FLATTEN_PARTIALLY_FILLED"
          : "FLATTEN_IN_PROGRESS";
      trade.updatedAt = new Date().toISOString();

      // Persist lifecycle incident so live-protection and agents see the state
      await saveFlattenIncident({
        incidentCode: flattenResult.state,
        symbol,
        tradeId: trade.id,
        detail: flattenResult.detail,
      });

      console.log("[protection-recover] flatten in progress", {
        symbol,
        tradeId: trade.id,
        state: flattenResult.state,
        brokerPositionQty: flattenResult.brokerPositionQty,
        activeCloseOrderId: flattenResult.activeCloseOrderId,
        activeCloseOrderDetected: flattenResult.activeCloseOrderDetected,
        closeOrderSubmitted: flattenResult.closeOrderSubmitted,
      });
    } else {
      // FLATTEN_FAILED — close order submission failed; position still unprotected
      diag.flattenSucceeded = false;
      diag.brokerPositionExistsAfter = true;
      diag.finalResolution = "failed";
      diag.error = (diag.error ? diag.error + "; " : "") + `flatten error: ${flattenResult.error ?? "unknown"}`;
      trade.protectionStatus = "FLATTEN_FAILED";
      trade.updatedAt = new Date().toISOString();

      // Persist as CRITICAL for manual intervention
      await saveFlattenIncident({
        incidentCode: "FLATTEN_FAILED",
        symbol,
        tradeId: trade.id,
        detail: flattenResult.error ?? flattenResult.detail,
      });

      console.error("[protection-recover] CRITICAL: flatten failed", {
        symbol,
        tradeId: trade.id,
        flattenError: flattenResult.error,
      });
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
  // AND is not in an active close-order state (which means it's being closed safely)
  const blockerStillActive = openPositions2.some((p: any) => {
    const sym = String(p.symbol).toUpperCase();
    if (Math.abs(Number(p.qty)) === 0) return false;
    const hasStop = openOrders2.some(
      (o: any) =>
        String(o.symbol).toUpperCase() === sym &&
        ["stop", "stop_limit", "trailing_stop"].includes(String(o.type || "").toLowerCase()) &&
        ["new", "accepted", "pending_new", "pending_replace", "held", "partially_filled"].includes(
          String(o.status || "").toLowerCase()
        )
    );
    if (hasStop) return false;
    // Position lacks stop — check if there's an active market close order  
    // If so, it's "in progress" — still a blocker but not an orphan
    const hasActiveClose = openOrders2.some(
      (o: any) =>
        String(o.symbol).toUpperCase() === sym &&
        String(o.type || "").toLowerCase() === "market" &&
        ["sell", "buy"].includes(String(o.side || "").toLowerCase()) &&
        ["new", "accepted", "pending_new", "partially_filled", "held"].includes(
          String(o.status || "").toLowerCase()
        )
    );
    // Blocker is still active (either naked, or in-progress close — either way blocks new trades)
    return !hasActiveClose || true; // always block while position exists without stop
  });

  // Compute overall resolution status
  const criticalFailures = details.filter((d) => d.finalResolution === "failed").length;
  const flattenInProgress = details.filter((d) => d.finalResolution === "flatten_in_progress").length;
  const flattened = details.filter((d) => d.finalResolution === "flattened").length;
  const protected_ = details.filter((d) => d.finalResolution === "protected").length;

  let resolutionStatus: string;
  if (details.length === 0) {
    resolutionStatus = "none";
  } else if (criticalFailures > 0) {
    resolutionStatus = "failed";
  } else if (flattenInProgress > 0) {
    resolutionStatus = "flatten_in_progress";
  } else if (protected_ > 0 && flattened > 0) {
    resolutionStatus = "partial";
  } else if (protected_ > 0) {
    resolutionStatus = "protected";
  } else if (flattened > 0) {
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
    flattenDiagnostics,
  };
}
