/**
 * Trade lifecycle helpers — execution attribution immutability and state normalization.
 *
 * Key invariant: once a trade has executeOutcome=EXECUTED or alpacaOrderId / brokerOrderId,
 * no downstream skip/cleanup/reconcile logic should overwrite executeOutcome or executeReason.
 * Those fields are the original execution record and must be preserved for funnel diagnostics.
 *
 * Downstream lifecycle updates (cooldown, capacity, drift skips detected AFTER execution) should
 * be stored in latestLifecycleOutcome / latestLifecycleReason instead.
 */

// ---------------------------------------------------------------------------
// Execution attribution immutability
// ---------------------------------------------------------------------------

/** Set of executeOutcome values that represent skip / cleanup / reconcile events.
 *  These must NOT overwrite an already-EXECUTED attribution. */
const SKIP_OUTCOMES = new Set([
  "SKIPPED_NO_LONGER_ELIGIBLE",
  "SKIPPED_CAPACITY",
  "SKIPPED_PRICE_DRIFT",
  "SKIPPED_MARKET_CLOSED",
  "SKIPPED_SCORE_THRESHOLD",
  "SKIPPED_PROTECTION_BLOCK",
  "SKIPPED_NO_AUTO_PENDING",
  "SKIPPED_EXPIRED",
  "SKIPPED_DUPLICATE",
  "SKIPPED_NO_FILL",
]);

/**
 * Returns true when the trade's execution attribution is immutable:
 * a broker order has already been placed for this trade.
 */
export function isExecutionAttributionImmutable(trade: any): boolean {
  return (
    trade?.executeOutcome === "EXECUTED" ||
    Boolean(trade?.alpacaOrderId) ||
    Boolean(trade?.brokerOrderId)
  );
}

/**
 * Merges `patch` into `existing` while protecting execution attribution.
 *
 * If the trade already has executeOutcome=EXECUTED (or a broker order ID), any attempt
 * to overwrite executeOutcome with a skip/error reason is redirected to
 * latestLifecycleOutcome / latestLifecycleReason instead of clobbering the original.
 *
 * Usage:
 *   trades[idx] = preserveExecutionAttribution(existing, patch);
 */
export function preserveExecutionAttribution(
  existing: any,
  patch: Record<string, any>,
): Record<string, any> {
  if (!isExecutionAttributionImmutable(existing)) {
    return { ...existing, ...patch };
  }

  const safePatch = { ...patch };
  const proposedOutcome = safePatch.executeOutcome;

  if (proposedOutcome !== undefined && SKIP_OUTCOMES.has(String(proposedOutcome))) {
    // Redirect to lifecycle-tracking fields; do NOT overwrite original EXECUTED attribution
    safePatch.latestLifecycleOutcome = proposedOutcome;
    safePatch.latestLifecycleReason = safePatch.executeReason ?? null;
    delete safePatch.executeOutcome;
    delete safePatch.executeReason;
  }

  return { ...existing, ...safePatch };
}

// ---------------------------------------------------------------------------
// Closed trade protection normalization
// ---------------------------------------------------------------------------

/**
 * Protection statuses that become meaningless once a trade is CLOSED/ARCHIVED/ERROR
 * with no broker position.  These should be cleared via normalizeClosedTradeProtection().
 */
const STALE_PROTECTION_STATUSES = new Set([
  "REPAIR_FAILED",
  "STOP_REPAIR_FAILED",
  "MISSING_STOP",
  "STOP_EXPIRED",
  "STOP_CANCELED",
  "REPAIRING",
  "FLATTEN_PENDING",
  "FLATTEN_IN_PROGRESS",
  "FLATTEN_PARTIALLY_FILLED",
  "FLATTEN_FAILED",
  "UNPROTECTED",
]);

/**
 * Returns a patch that normalizes a stale protectionStatus on a closed trade.
 * Returns an empty object when normalization is not needed.
 *
 * A trade qualifies when:
 *   - status is CLOSED, ERROR, or ARCHIVED
 *   - protectionStatus is in the stale set (risk-related states that imply an open position)
 *
 * After normalization:
 *   - protectionStatus → null  (no position → not applicable)
 *   - closedAt is set if missing
 *   - closeReason is set if missing
 */
export function normalizeClosedTradeProtection(
  trade: any,
  nowIso: string,
): Record<string, any> {
  const status = String(trade?.status || "").toUpperCase();
  const isClosed =
    status === "CLOSED" || status === "ERROR" || status === "ARCHIVED";
  if (!isClosed) return {};

  const ps = String(trade?.protectionStatus || "");
  if (!STALE_PROTECTION_STATUSES.has(ps)) return {};

  const patch: Record<string, any> = {
    protectionStatus: null,
    updatedAt: nowIso,
  };

  if (!trade?.closedAt) {
    patch.closedAt = nowIso;
  }

  if (!trade?.closeReason) {
    patch.closeReason = "broker_sync_closed";
  }

  return patch;
}

// ---------------------------------------------------------------------------
// Broker-sync execution attribution fix
// ---------------------------------------------------------------------------

/**
 * When broker-sync transitions a trade from non-OPEN → OPEN because a broker
 * position/fill is detected, the executeOutcome should reflect EXECUTED.
 * This corrects the case where a previous execute-route run wrote
 * executeOutcome=SKIPPED_* (e.g. ticker_cooldown) but the trade was later
 * executed through a different path (manual, retry, external order).
 *
 * Returns a patch to apply; returns empty object if nothing is needed.
 */
export function buildBrokerSyncExecutedPatch(trade: any, nowIso: string): Record<string, any> {
  if (!trade) return {};

  // Already correctly attributed
  if (trade.executeOutcome === "EXECUTED") return {};

  // Only apply when transitioning to OPEN with broker evidence
  const patch: Record<string, any> = {
    executeOutcome: "EXECUTED",
    executeReason: trade.executeReason === "placed" ? "placed" : "broker_sync_filled",
    updatedAt: nowIso,
  };

  // Preserve original skip reason for diagnostics
  if (trade.executeOutcome && trade.executeOutcome !== "EXECUTED") {
    patch.latestLifecycleOutcome = trade.executeOutcome;
    patch.latestLifecycleReason = trade.executeReason ?? null;
  }

  return patch;
}
