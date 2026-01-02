export type NotificationEventType =
  | "AUTO_ENTRY_PLACED"
  | "AUTO_ENTRY_FAILED"
  | "AUTO_ENTRY_DISABLED"
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
