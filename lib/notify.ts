const PUSHOVER_API_URL = "https://api.pushover.net/1/messages.json";

export async function sendPullbackAlert(opts: {
  ticker: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  stopPrice?: number | null;
  score?: number;
  reason?: string;
}) {
  const token =
    process.env.PUSHOVER_API_TOKEN ||
    process.env.PUSHOVER_APP_TOKEN;
  const user = process.env.PUSHOVER_USER_KEY;
  const url = process.env.PULLBACK_ALERT_URL;

  if (!token || !user) {
    console.warn("[notify] missing PUSHOVER_USER_KEY or PUSHOVER_API_TOKEN; skipping");
    return;
  }

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

  const formData = new URLSearchParams();
  formData.append("token", token);
  formData.append("user", user);
  formData.append("title", title);
  formData.append("message", message);

  // Optional: pick a louder sound (see Pushover docs for names: "siren", "bike", etc.)
  // formData.append("sound", "siren");

  if (url) {
    formData.append("url", url);
    formData.append("url_title", "Open Cecil Trading · Today");
  }

  try {
    const res = await fetch(PUSHOVER_API_URL, {
      method: "POST",
      body: formData,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("[notify] Pushover error:", res.status, text);
    }
  } catch (err) {
    console.error("[notify] Pushover request failed", err);
  }
}
