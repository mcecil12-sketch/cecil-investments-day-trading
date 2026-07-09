const PUSHOVER_API_URL = "https://api.pushover.net/1/messages.json";

export async function notify(title: string, message: string) {
  const approvalsDisabled = process.env.DISABLE_APPROVAL_NOTIFICATIONS === "1";
  const isApproval = /ready for approval|approval/i.test(`${title} ${message}`);
  if (approvalsDisabled && isApproval) {
    console.log("[notify] approval notifications disabled; skipping", { title });
    return { ok: true, skipped: true, skippedReason: "approval_notifications_disabled" } as any;
  }

  const user = process.env.PUSHOVER_USER_KEY;
  const token =
    process.env.PUSHOVER_API_TOKEN ||
    process.env.PUSHOVER_APP_TOKEN;
  if (!user || !token) {
    const missing = {
      user: Boolean(user),
      token: Boolean(token),
    };
    console.log("[notify] missing env; skipping", missing);
    return { ok: false, skipped: true, missing };
  }

  const body = new URLSearchParams({
    token,
    user,
    title,
    message,
  });

  const resp = await fetch(PUSHOVER_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await resp.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}

  if (!resp.ok) {
    console.log("[notify] pushover error", { status: resp.status, body: json ?? text });
    return { ok: false, status: resp.status, body: json ?? text };
  }

  console.log("[notify] pushover ok", json ?? text);
  return { ok: true, status: resp.status, body: json ?? text };
}

export async function sendPullbackAlert(opts: {
  ticker: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  stopPrice?: number | null;
  score?: number;
  reason?: string;
}) {
  const url = process.env.PULLBACK_ALERT_URL;

  const { ticker, side, entryPrice, stopPrice, score, reason } = opts;

  const title = `A-grade pullback ready: ${ticker} (${side})`;
  const scorePart =
    typeof score === "number" ? `Score: ${score.toFixed(1)} · ` : "";
  const stopPart =
    stopPrice != null ? `Stop: ${stopPrice.toFixed(2)} · ` : "";
  const bodyLines = [
    `${ticker} ${side} pullback is ready for approval.`,
    `${scorePart}Entry: ${entryPrice.toFixed(2)} · ${stopPart}`.trim(),
    reason ? `Reason: ${reason}` : "",
    url ? `Tap to open: ${url}` : "",
  ].filter(Boolean);

  const message = bodyLines.join("\n");

  const result = await notify(title, message);

  if (!result.ok) {
    console.warn("[notify] sendPullbackAlert failed", result);
  }
  return result;
}
