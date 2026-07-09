export async function requireAuth(req: Request): Promise<{ ok: boolean }> {
  const cookie = req.headers.get("cookie") ?? "";
  if (cookie.split(";").some((part) => part.trim() === "auth_pin=1")) {
    return { ok: true };
  }

  const headerPin =
    req.headers.get("x-app-pin") ?? req.headers.get("authorization") ?? "";
  const pin = headerPin.replace(/^Bearer\s+/i, "").trim();
  if (pin && process.env.APP_PIN && pin === process.env.APP_PIN) {
    return { ok: true };
  }

  return { ok: false };
}
