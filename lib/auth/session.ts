/**
 * Signed session-cookie helpers for the platform's single-user PIN gate.
 *
 * Deliberately built on the Web Crypto API (`crypto.subtle`, `TextEncoder`,
 * `btoa`/`atob`) rather than Node's `crypto` module: this file is imported
 * by both `middleware.ts` (which Next.js always runs in the Edge Runtime,
 * even on Next 14 — no Node builtins available there) and the Node-runtime
 * `/api/auth/*` routes, so it has to work in both without a runtime branch.
 */

export const SESSION_COOKIE_NAME = "cecil_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET (or NEXTAUTH_SECRET) is not configured on the server");
  }
  return secret;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function signPayload(payload: string): Promise<string> {
  const key = await importHmacKey(getSessionSecret());
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return bytesToBase64Url(new Uint8Array(signature));
}

/** Constant-time string comparison so signature checks don't leak timing info. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/** A signed, expiring session token — `payload.signature`, both base64url. */
export async function createSessionToken(): Promise<string> {
  const expiresAt = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
  const payload = bytesToBase64Url(new TextEncoder().encode(String(expiresAt)));
  const signature = await signPayload(payload);
  return `${payload}.${signature}`;
}

/** Verifies signature and expiry. Never throws — a malformed/missing token just isn't valid. */
export async function verifySessionToken(token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, signature] = parts;

  try {
    const expectedSignature = await signPayload(payload);
    if (!timingSafeEqual(expectedSignature, signature)) return false;

    const expiresAt = Number(new TextDecoder().decode(base64UrlToBytes(payload)));
    if (!Number.isFinite(expiresAt)) return false;
    return Date.now() < expiresAt;
  } catch {
    return false;
  }
}
