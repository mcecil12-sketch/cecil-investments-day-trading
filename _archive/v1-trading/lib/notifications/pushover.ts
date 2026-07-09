const PUSHOVER_API_URL = "https://api.pushover.net/1/messages.json";

type PushoverPayload = {
  token: string;
  user: string;
  title: string;
  message: string;
  priority?: number;
  url?: string;
  url_title?: string;
  timestamp?: number;
};

export async function sendPushoverNotification(payload: PushoverPayload) {
  const body = new URLSearchParams({
    token: payload.token,
    user: payload.user,
    title: payload.title,
    message: payload.message,
  });
  if (typeof payload.priority === "number") {
    body.set("priority", payload.priority.toString());
  }
  if (payload.url) body.set("url", payload.url);
  if (payload.url_title) body.set("url_title", payload.url_title);
  if (payload.timestamp) body.set("timestamp", payload.timestamp.toString());

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

  return { ok: resp.ok, status: resp.status, body: json ?? text };
}
