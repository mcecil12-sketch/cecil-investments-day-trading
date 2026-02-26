import type { NotificationEvent } from "@/lib/notifications/types";

export function notificationEnv(): string {
  return String(process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown").toLowerCase();
}

export function shouldSendAutoEntryDisabledNotification(envRaw?: string): boolean {
  const env = String(envRaw || notificationEnv()).toLowerCase();
  const allowPreview = String(process.env.ALLOW_PREVIEW_NOTIFICATIONS || "0").toLowerCase();
  const previewAllowed = ["1", "true", "yes", "on"].includes(allowPreview);
  if (env === "preview" && !previewAllowed) return false;
  return true;
}

export function buildAutoEntryDisabledNotificationEvent(args: {
  tradeId: string;
  ticker: string;
  reason: string;
  host: string;
  env: string;
  etDate: string;
  runId: string;
}): NotificationEvent {
  const envLabel = args.env || "unknown";
  const hostLabel = args.host || "unknown-host";
  const runLabel = args.runId || "none";
  const prefix = `[${envLabel}] ${hostLabel}`;

  return {
    type: "AUTO_ENTRY_DISABLED",
    tradeId: args.tradeId,
    ticker: args.ticker,
    title: `${prefix} Auto entry disabled ${args.ticker}`,
    message: `${prefix} Auto entry disabled: ${args.reason} etDate=${args.etDate} runId=${runLabel}`,
    paper: true,
    dedupeKey: "AUTO_ENTRY_DISABLED",
    dedupeTtlSec: 3600,
    meta: {
      env: envLabel,
      host: hostLabel,
      etDate: args.etDate,
      runId: runLabel,
      reason: args.reason,
      ticker: args.ticker,
      tradeId: args.tradeId,
    },
  };
}
