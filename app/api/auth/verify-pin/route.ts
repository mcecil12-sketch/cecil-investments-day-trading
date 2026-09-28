import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { createSessionToken, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from "@/lib/auth/session";

// ACCESS_PIN is stored as plain text in the environment (so it's just a
// normal Vercel env var, not something you have to pre-hash yourself) and
// hashed once, lazily, the first time this process handles a verify — every
// subsequent comparison reuses that hash via bcrypt.compare rather than
// comparing the plain PIN directly.
let cachedPinHash: string | null = null;

function getPinHash(): string {
  if (cachedPinHash) return cachedPinHash;
  const pin = process.env.ACCESS_PIN;
  if (!pin) throw new Error("ACCESS_PIN is not configured on the server");
  cachedPinHash = bcrypt.hashSync(pin, 10);
  return cachedPinHash;
}

// Coarse, in-memory brute-force guard: this app has exactly one valid PIN of
// only 4-6 digits, so an unthrottled endpoint could be brute-forced in well
// under a minute. Not a durable/distributed limiter (each serverless
// instance keeps its own counts, and a redeploy resets it) — just cheap
// friction with no extra infrastructure, appropriate for a single-user app.
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 10;
const attemptsByClient = new Map<string, { count: number; windowStart: number }>();

function isRateLimited(clientKey: string): boolean {
  const now = Date.now();
  const entry = attemptsByClient.get(clientKey);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    attemptsByClient.set(clientKey, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX_ATTEMPTS;
}

function getClientKey(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

export async function POST(request: NextRequest) {
  if (isRateLimited(getClientKey(request))) {
    return NextResponse.json({ success: false, error: "Too many attempts — try again later" }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  const pin = typeof body?.pin === "string" ? body.pin : "";

  if (!/^\d{4,6}$/.test(pin)) {
    return NextResponse.json({ success: false }, { status: 400 });
  }

  let pinHash: string;
  try {
    pinHash = getPinHash();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }

  if (!bcrypt.compareSync(pin, pinHash)) {
    return NextResponse.json({ success: false }, { status: 401 });
  }

  const token = await createSessionToken();
  const response = NextResponse.json({ success: true });
  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return response;
}
