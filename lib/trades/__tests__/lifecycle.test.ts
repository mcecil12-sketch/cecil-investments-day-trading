import { describe, it, expect } from "vitest";
import {
  isExecutionAttributionImmutable,
  preserveExecutionAttribution,
  normalizeClosedTradeProtection,
  buildBrokerSyncExecutedPatch,
  shouldSendEntryNotification,
  shouldSendCloseNotification,
  markEntryNotificationSent,
  markCloseNotificationSent,
} from "@/lib/trades/lifecycle";

const NOW = "2026-03-01T12:00:00.000Z";

// ─────────────────────────────────────────────────────────────────────────────
// isExecutionAttributionImmutable
// ─────────────────────────────────────────────────────────────────────────────

describe("isExecutionAttributionImmutable", () => {
  it("returns true when executeOutcome is EXECUTED", () => {
    expect(isExecutionAttributionImmutable({ executeOutcome: "EXECUTED" })).toBe(true);
  });

  it("returns true when alpacaOrderId is present", () => {
    expect(isExecutionAttributionImmutable({ alpacaOrderId: "ord-abc" })).toBe(true);
  });

  it("returns true when brokerOrderId is present", () => {
    expect(isExecutionAttributionImmutable({ brokerOrderId: "br-123" })).toBe(true);
  });

  it("returns false when no broker evidence and not EXECUTED", () => {
    expect(isExecutionAttributionImmutable({ executeOutcome: "SKIPPED_NO_LONGER_ELIGIBLE" })).toBe(false);
  });

  it("returns false for an empty trade object", () => {
    expect(isExecutionAttributionImmutable({})).toBe(false);
  });

  it("returns false for null / undefined", () => {
    expect(isExecutionAttributionImmutable(null)).toBe(false);
    expect(isExecutionAttributionImmutable(undefined)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// preserveExecutionAttribution
// ─────────────────────────────────────────────────────────────────────────────

describe("preserveExecutionAttribution", () => {
  const executedTrade = {
    id: "t-1",
    ticker: "GM",
    executeOutcome: "EXECUTED",
    executeReason: "placed",
    alpacaOrderId: "ord-gm-001",
  };

  it("does not overwrite executeOutcome=EXECUTED when patch contains a SKIP outcome", () => {
    const result = preserveExecutionAttribution(executedTrade, {
      executeOutcome: "SKIPPED_NO_LONGER_ELIGIBLE",
      executeReason: "ticker_cooldown",
    });
    expect(result.executeOutcome).toBe("EXECUTED");
    expect(result.executeReason).toBe("placed");
  });

  it("redirects SKIP to latestLifecycleOutcome when trade is immutable", () => {
    const result = preserveExecutionAttribution(executedTrade, {
      executeOutcome: "SKIPPED_NO_LONGER_ELIGIBLE",
      executeReason: "ticker_cooldown",
    });
    expect(result.latestLifecycleOutcome).toBe("SKIPPED_NO_LONGER_ELIGIBLE");
    expect(result.latestLifecycleReason).toBe("ticker_cooldown");
  });

  it("redirects SKIPPED_CAPACITY when trade has alpacaOrderId", () => {
    const result = preserveExecutionAttribution(
      { executeOutcome: "EXECUTED", alpacaOrderId: "ord-1" },
      { executeOutcome: "SKIPPED_CAPACITY", executeReason: "max_open_positions" },
    );
    expect(result.executeOutcome).toBe("EXECUTED");
    expect(result.latestLifecycleOutcome).toBe("SKIPPED_CAPACITY");
  });

  it("allows non-skip fields to be applied normally on immutable trade", () => {
    const result = preserveExecutionAttribution(executedTrade, {
      status: "OPEN",
      autoEntryStatus: "AUTO_OPEN",
    });
    expect(result.status).toBe("OPEN");
    expect(result.executeOutcome).toBe("EXECUTED");
  });

  it("applies patch normally when trade is NOT immutable", () => {
    const pending = { id: "t-2", executeOutcome: "PENDING" };
    const result = preserveExecutionAttribution(pending, {
      executeOutcome: "SKIPPED_NO_LONGER_ELIGIBLE",
      executeReason: "ticker_cooldown",
    });
    expect(result.executeOutcome).toBe("SKIPPED_NO_LONGER_ELIGIBLE");
    expect(result.executeReason).toBe("ticker_cooldown");
    expect(result.latestLifecycleOutcome).toBeUndefined();
  });

  it("does not redirect a non-SKIP outcome even on immutable trade", () => {
    const result = preserveExecutionAttribution(executedTrade, {
      executeOutcome: "ERROR",
    });
    // ERROR is not in SKIP_OUTCOMES, so it should pass through
    expect(result.executeOutcome).toBe("ERROR");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizeClosedTradeProtection
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeClosedTradeProtection", () => {
  it("clears REPAIR_FAILED protectionStatus on CLOSED trade", () => {
    const trade = { status: "CLOSED", protectionStatus: "REPAIR_FAILED", closedAt: NOW };
    const patch = normalizeClosedTradeProtection(trade, NOW);
    expect(patch.protectionStatus).toBeNull();
  });

  it("clears MISSING_STOP protectionStatus on ERROR trade", () => {
    const trade = { status: "ERROR", protectionStatus: "MISSING_STOP" };
    const patch = normalizeClosedTradeProtection(trade, NOW);
    expect(patch.protectionStatus).toBeNull();
  });

  it("sets closedAt if missing", () => {
    const trade = { status: "CLOSED", protectionStatus: "FLATTEN_FAILED" };
    const patch = normalizeClosedTradeProtection(trade, NOW);
    expect(patch.closedAt).toBe(NOW);
  });

  it("preserves existing closedAt", () => {
    const earlier = "2026-02-01T00:00:00.000Z";
    const trade = { status: "CLOSED", protectionStatus: "UNPROTECTED", closedAt: earlier };
    const patch = normalizeClosedTradeProtection(trade, NOW);
    expect(patch.closedAt).toBeUndefined();
  });

  it("returns empty object for OPEN trade (no normalization needed)", () => {
    const trade = { status: "OPEN", protectionStatus: "REPAIR_FAILED" };
    const patch = normalizeClosedTradeProtection(trade, NOW);
    expect(patch).toEqual({});
  });

  it("returns empty object when protectionStatus is already null", () => {
    const trade = { status: "CLOSED", protectionStatus: null };
    const patch = normalizeClosedTradeProtection(trade, NOW);
    expect(patch).toEqual({});
  });

  it("returns empty object when protectionStatus is a non-stale value", () => {
    const trade = { status: "CLOSED", protectionStatus: "PROTECTED" };
    const patch = normalizeClosedTradeProtection(trade, NOW);
    expect(patch).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildBrokerSyncExecutedPatch
// ─────────────────────────────────────────────────────────────────────────────

describe("buildBrokerSyncExecutedPatch", () => {
  it("returns empty object when executeOutcome is already EXECUTED", () => {
    const trade = { executeOutcome: "EXECUTED", executeReason: "placed" };
    expect(buildBrokerSyncExecutedPatch(trade, NOW)).toEqual({});
  });

  it("sets executeOutcome=EXECUTED when stale SKIP is present", () => {
    const trade = { executeOutcome: "SKIPPED_NO_LONGER_ELIGIBLE", executeReason: "ticker_cooldown" };
    const patch = buildBrokerSyncExecutedPatch(trade, NOW);
    expect(patch.executeOutcome).toBe("EXECUTED");
    expect(patch.executeReason).toBe("broker_sync_filled");
  });

  it("preserves original skip reason in latestLifecycleOutcome", () => {
    const trade = { executeOutcome: "SKIPPED_CAPACITY", executeReason: "max_open_positions" };
    const patch = buildBrokerSyncExecutedPatch(trade, NOW);
    expect(patch.latestLifecycleOutcome).toBe("SKIPPED_CAPACITY");
    expect(patch.latestLifecycleReason).toBe("max_open_positions");
  });

  it("keeps executeReason=placed when prior reason is 'placed'", () => {
    const trade = { executeOutcome: "SKIPPED_NO_LONGER_ELIGIBLE", executeReason: "placed" };
    const patch = buildBrokerSyncExecutedPatch(trade, NOW);
    expect(patch.executeReason).toBe("placed");
  });

  it("returns empty object for null trade", () => {
    expect(buildBrokerSyncExecutedPatch(null, NOW)).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// shouldSendEntryNotification
// ─────────────────────────────────────────────────────────────────────────────

describe("shouldSendEntryNotification", () => {
  it("returns true when alpacaOrderId present and no entryNotificationSentAt", () => {
    expect(shouldSendEntryNotification({ alpacaOrderId: "ord-1" })).toBe(true);
  });

  it("returns true when brokerOrderId present and no entryNotificationSentAt", () => {
    expect(shouldSendEntryNotification({ brokerOrderId: "br-1" })).toBe(true);
  });

  it("returns false when entryNotificationSentAt already set", () => {
    expect(shouldSendEntryNotification({ alpacaOrderId: "ord-1", entryNotificationSentAt: NOW })).toBe(false);
  });

  it("returns false when no broker evidence", () => {
    expect(shouldSendEntryNotification({ executeOutcome: "PENDING" })).toBe(false);
  });

  it("returns false for null", () => {
    expect(shouldSendEntryNotification(null)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// shouldSendCloseNotification
// ─────────────────────────────────────────────────────────────────────────────

describe("shouldSendCloseNotification", () => {
  it("returns true for CLOSED trade with alpacaOrderId and no closeNotificationSentAt", () => {
    expect(shouldSendCloseNotification({ status: "CLOSED", alpacaOrderId: "ord-1" })).toBe(true);
  });

  it("returns true for ERROR trade with executeOutcome=EXECUTED", () => {
    expect(shouldSendCloseNotification({ status: "ERROR", executeOutcome: "EXECUTED" })).toBe(true);
  });

  it("returns false when closeNotificationSentAt already set", () => {
    expect(shouldSendCloseNotification({
      status: "CLOSED",
      alpacaOrderId: "ord-1",
      closeNotificationSentAt: NOW,
    })).toBe(false);
  });

  it("returns false for OPEN trade", () => {
    expect(shouldSendCloseNotification({ status: "OPEN", alpacaOrderId: "ord-1" })).toBe(false);
  });

  it("returns false for AUTO_PENDING trade with no broker evidence", () => {
    expect(shouldSendCloseNotification({ status: "AUTO_PENDING" })).toBe(false);
  });

  it("returns false for CLOSED trade with no broker evidence", () => {
    expect(shouldSendCloseNotification({ status: "CLOSED", executeOutcome: "SKIPPED_EXPIRED" })).toBe(false);
  });

  it("returns false for null", () => {
    expect(shouldSendCloseNotification(null)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// markEntryNotificationSent / markCloseNotificationSent
// ─────────────────────────────────────────────────────────────────────────────

describe("markEntryNotificationSent", () => {
  it("returns patch with entryNotificationSentAt and default reason", () => {
    const patch = markEntryNotificationSent(NOW);
    expect(patch.entryNotificationSentAt).toBe(NOW);
    expect(patch.lastNotificationReason).toBe("order_submitted");
    expect(patch.updatedAt).toBe(NOW);
  });

  it("accepts a custom reason", () => {
    const patch = markEntryNotificationSent(NOW, "custom_reason");
    expect(patch.lastNotificationReason).toBe("custom_reason");
  });
});

describe("markCloseNotificationSent", () => {
  it("returns patch with closeNotificationSentAt and default reason", () => {
    const patch = markCloseNotificationSent(NOW);
    expect(patch.closeNotificationSentAt).toBe(NOW);
    expect(patch.lastNotificationReason).toBe("trade_closed");
    expect(patch.updatedAt).toBe(NOW);
  });

  it("accepts a custom reason", () => {
    const patch = markCloseNotificationSent(NOW, "stop_hit");
    expect(patch.lastNotificationReason).toBe("stop_hit");
  });
});

