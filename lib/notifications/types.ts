export type NotificationEventType =
  | "AUTO_ENTRY_PLACED"
  | "AUTO_ENTRY_SUBMITTED"
  | "AUTO_ENTRY_OPEN"
  | "AUTO_ENTRY_FAILED"
  | "AUTO_ENTRY_DISABLED"
  | "AUTO_CUT_LOSS"
  | "TRADE_CLOSED"
  | "STOP_HIT"
  | "APPROVAL_REQUIRED"
  | "PULLBACK_READY"
  | "SIGNAL_APPROVAL";

export type NotificationEvent = {
  type: NotificationEventType;
  tradeId?: string;
  ticker?: string;
  tier?: "A" | "B" | "C";
  paper?: boolean;
  title: string;
  message: string;
  priority?: number;
  url?: string;
  url_title?: string;
  meta?: Record<string, any>;
  dedupeKey?: string;
  dedupeTtlSec?: number;
  skipDedupe?: boolean;
};

/**
 * Notification lifecycle tracking fields stored on the trade record.
 * These prevent duplicate notifications and allow lifecycle tracking.
 */
export type TradeNotificationFields = {
  /** ISO timestamp when the "entry submitted" notification was sent. */
  entryNotificationSentAt?: string | null;
  /** ISO timestamp when the "entry filled / OPEN" notification was sent. */
  openNotificationSentAt?: string | null;
  /** ISO timestamp when the "trade closed" notification was sent. */
  closeNotificationSentAt?: string | null;
  /** Human-readable reason recorded on the last notification sent. */
  lastNotificationReason?: string | null;
};

