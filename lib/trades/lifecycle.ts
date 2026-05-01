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

// ---------------------------------------------------------------------------
// Notification send decision helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when an entry notification should be sent for this trade.
 *
 * Gate: broker execution evidence must exist (alpacaOrderId / brokerOrderId)
 * and the notification must not have been sent already.
 */
export function shouldSendEntryNotification(trade: any): boolean {
  if (!trade) return false;
  if (trade.entryNotificationSentAt) return false;
  return Boolean(trade.alpacaOrderId) || Boolean(trade.brokerOrderId);
}

/**
 * Returns true when a close notification should be sent for this trade.
 *
 * Gate:
 *  - trade is CLOSED or ERROR
 *  - has broker execution evidence (alpacaOrderId, brokerOrderId, or executeOutcome=EXECUTED)
 *  - close notification has not already been sent (closeNotificationSentAt is absent)
 *
 * This deliberately excludes stale AUTO_PENDING / ARCHIVED trades that were
 * never broker-submitted — they do not warrant a "trade closed" notification.
 */
export function shouldSendCloseNotification(trade: any): boolean {
  if (!trade) return false;
  const status = String(trade?.status || "").toUpperCase();
  if (status !== "CLOSED" && status !== "ERROR") return false;
  if (trade.closeNotificationSentAt) return false;
  return (
    Boolean(trade.alpacaOrderId) ||
    Boolean(trade.brokerOrderId) ||
    trade.executeOutcome === "EXECUTED"
  );
}

/**
 * Returns a patch object that records an entry notification as sent.
 * Apply this to the trade before or immediately after dispatching the notification.
 */
export function markEntryNotificationSent(
  nowIso: string,
  reason = "order_submitted",
): Record<string, any> {
  return {
    entryNotificationSentAt: nowIso,
    lastNotificationReason: reason,
    updatedAt: nowIso,
  };
}

/**
 * Returns a patch object that records a close notification as sent.
 * Apply this to the trade after dispatching the close notification.
 */
export function markCloseNotificationSent(
  nowIso: string,
  reason = "trade_closed",
): Record<string, any> {
  return {
    closeNotificationSentAt: nowIso,
    lastNotificationReason: reason,
    updatedAt: nowIso,
  };
}

// ---------------------------------------------------------------------------
// Terminal trade lifecycle cleanup
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set(["ERROR", "ARCHIVED"]);
const TERMINAL_EXECUTE_OUTCOMES = new Set([
  "MALFORMED",
  "SKIPPED_PRICE_DRIFT",
  "SKIPPED_EXPIRED",
  "SKIPPED_NO_LONGER_ELIGIBLE",
  "ERROR",
  "PENDING",
]);
const TERMINAL_EXECUTE_REASONS = new Set([
  "invalid_pending_missing_risk",
  "invalid_trade",
  "rescore_required",
  "stale_trade",
]);

/**
 * Ensures terminal lifecycle fields are present for error/archived trades.
 *
 * Rules:
 * - If trade is ERROR/ARCHIVED and closedAt is null, set closedAt from
 *   executeAttemptedAt || updatedAt || nowIso.
 * - If trade is ERROR/ARCHIVED, OR executeOutcome/reason indicates terminal skip,
 *   set executeAttemptedAt when missing using updatedAt || nowIso.
 */
export function normalizeTerminalTradeLifecycle(
  trade: any,
  nowIso: string,
): { changed: boolean; trade: any } {
  if (!trade || typeof trade !== "object") return { changed: false, trade };

  const status = String(trade?.status || "").toUpperCase();
  const executeOutcome = String(trade?.executeOutcome || "").toUpperCase();
  const executeReason = String(trade?.executeReason || "").toLowerCase();

  const isTerminalStatus = TERMINAL_STATUSES.has(status);
  const terminalOutcome = TERMINAL_EXECUTE_OUTCOMES.has(executeOutcome);
  const terminalReason = TERMINAL_EXECUTE_REASONS.has(executeReason);

  let changed = false;
  const next = { ...trade };

  if ((isTerminalStatus || terminalOutcome || terminalReason) && !next.executeAttemptedAt) {
    next.executeAttemptedAt = next.updatedAt || nowIso;
    changed = true;
  }

  if (isTerminalStatus && !next.closedAt) {
    next.closedAt = next.executeAttemptedAt || next.updatedAt || nowIso;
    changed = true;
  }

  if (changed && !next.updatedAt) {
    next.updatedAt = nowIso;
  }

  return { changed, trade: changed ? next : trade };
}

/**
 * Repairs stale terminal trades that are missing closedAt.
 *
 * Criteria:
 * - status in ERROR or ARCHIVED
 * - executeOutcome in MALFORMED, SKIPPED_PRICE_DRIFT, SKIPPED_EXPIRED,
 *   SKIPPED_NO_LONGER_ELIGIBLE, ERROR, PENDING
 * - closedAt is null
 */
export function repairStaleTerminalTrades(
  trades: any[],
  nowIso: string,
): { trades: any[]; staleTerminalRepairedCount: number } {
  let staleTerminalRepairedCount = 0;

  const nextTrades = (Array.isArray(trades) ? trades : []).map((t) => {
    if (!t || typeof t !== "object") return t;
    const status = String(t?.status || "").toUpperCase();
    const executeOutcome = String(t?.executeOutcome || "").toUpperCase();

    const shouldRepair =
      TERMINAL_STATUSES.has(status) &&
      TERMINAL_EXECUTE_OUTCOMES.has(executeOutcome) &&
      !t?.closedAt;

    if (!shouldRepair) return t;

    staleTerminalRepairedCount += 1;
    return {
      ...t,
      executeAttemptedAt: t?.executeAttemptedAt || t?.updatedAt || nowIso,
      closedAt: t?.executeAttemptedAt || t?.updatedAt || nowIso,
      updatedAt: t?.updatedAt || nowIso,
    };
  });

  return { trades: nextTrades, staleTerminalRepairedCount };
}
