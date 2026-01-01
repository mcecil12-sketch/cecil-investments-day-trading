import { NotificationEventType } from "./types";

const DEFAULT_EVENTS: NotificationEventType[] = [
  "AUTO_ENTRY_PLACED",
  "AUTO_ENTRY_FAILED",
  "AUTO_ENTRY_DISABLED",
  "TRADE_CLOSED",
  "STOP_HIT",
];

const TIER_ORDER: Record<"A" | "B" | "C", number> = { C: 0, B: 1, A: 2 };

function csvToSet(value?: string): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  );
}

export type NotificationConfig = {
  enabled: boolean;
  paperEnabled: boolean;
  liveEnabled: boolean;
  allowedEvents: Set<string>;
  tierMin: "A" | "B" | "C";
  dedupeTtl: number;
};

export function getNotificationConfig(): NotificationConfig {
  const enabled = String(process.env.NOTIFY_ENABLED ?? "true").toLowerCase();
  const paperEnabled = String(process.env.NOTIFY_PAPER_ENABLED ?? "true").toLowerCase();
  const liveEnabled = String(process.env.NOTIFY_LIVE_ENABLED ?? "false").toLowerCase();
  const tierMinRaw = (process.env.NOTIFY_TIER_MIN ?? "C").toUpperCase();
  const tierMin = tierMinRaw === "A" || tierMinRaw === "B" ? (tierMinRaw as "A" | "B") : "C";
  const dedupeTtl = Number(process.env.NOTIFY_DEDUPE_TTL_SEC ?? 3600);

  const envEvents = csvToSet(process.env.NOTIFY_EVENTS);
  const allowedEvents =
    envEvents.size === 0
      ? new Set(DEFAULT_EVENTS.map((e) => e.toUpperCase()))
      : envEvents;

  return {
    enabled: ["1", "true", "yes", "on"].includes(enabled),
    paperEnabled: ["1", "true", "yes", "on"].includes(paperEnabled),
    liveEnabled: ["1", "true", "yes", "on"].includes(liveEnabled),
    allowedEvents,
    tierMin,
    dedupeTtl: Number.isFinite(dedupeTtl) && dedupeTtl > 0 ? dedupeTtl : 3600,
  };
}

export function tierAllowed(eventTier: "A" | "B" | "C" | undefined, minTier: "A" | "B" | "C") {
  if (!eventTier) return true;
  return TIER_ORDER[eventTier] >= TIER_ORDER[minTier];
}
