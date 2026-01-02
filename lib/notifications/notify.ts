import { tierAllowed, getNotificationConfig } from "./config";
import { NotificationEvent } from "./types";
import { shouldSendNotification } from "./dedupe";
import { sendPushoverNotification } from "./pushover";

export async function notify(event: NotificationEvent) {
  const approvalsDisabled =
    process.env.DISABLE_APPROVAL_NOTIFICATIONS === "1";
  const type = String(event?.type || "");
  const isApprovalType =
    type === "APPROVAL_REQUIRED" ||
    type === "SIGNAL_APPROVAL" ||
    type === "PULLBACK_READY" ||
    type === "APPROVAL" ||
    type === "READY_FOR_APPROVAL";

  if (approvalsDisabled && isApprovalType) {
    return {
      sent: false,
      skippedReason: "approval_notifications_disabled",
    };
  }

  const config = getNotificationConfig();
  if (!config.enabled) {
    return { sent: false, skippedReason: "notifications_disabled" };
  }

  const modeEnabled = event.paper ? config.paperEnabled : config.liveEnabled;
  if (!modeEnabled) {
    return { sent: false, skippedReason: event.paper ? "paper_disabled" : "live_disabled" };
  }

  if (!config.allowedEvents.has(event.type.toUpperCase())) {
    return { sent: false, skippedReason: "event_not_allowed" };
  }

  if (!tierAllowed(event.tier, config.tierMin)) {
    return { sent: false, skippedReason: "tier_too_low" };
  }

  const dedupeKeyParts = [
    event.type,
    event.tradeId ?? "",
    event.dedupeKey ?? event.meta?.dedupeKey ?? "",
  ];
  const eventKey = dedupeKeyParts.filter(Boolean).join(":");
  const ttl = event.dedupeTtlSec ?? config.dedupeTtl;
  if (eventKey && !event.skipDedupe) {
    const allowed = await shouldSendNotification(eventKey, ttl);
    if (!allowed) {
      return { sent: false, skippedReason: "deduped" };
    }
  }

  const user = process.env.PUSHOVER_USER_KEY;
  const token =
    process.env.PUSHOVER_API_TOKEN || process.env.PUSHOVER_APP_TOKEN;
  if (!user || !token) {
    return { sent: false, skippedReason: "pushover_env_missing" };
  }

  const payload = {
    token,
    user,
    title: event.title,
    message: event.message,
    priority: event.priority,
    url: event.url,
    url_title: event.url_title,
    timestamp: Math.floor(Date.now() / 1000),
  };

  try {
    const resp = await sendPushoverNotification(payload);
    if (!resp.ok) {
      return { sent: false, skippedReason: "pushover_error", detail: resp.body };
    }
    return { sent: true };
  } catch (err) {
    console.error("[notify] push failed", err);
    return { sent: false, skippedReason: "pushover_exception" };
  }
}

export { notify as sendNotification };
