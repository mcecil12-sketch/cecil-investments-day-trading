export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { createPrivateKey } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { checkAgentCronAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";

// Mirror the exact normalization logic from lib/agents/github/auth.ts
// so this debug output matches real execution behaviour.
function normalizePrivateKey(rawKey: string): string {
  let normalized = rawKey.trim();

  const hasDoubleQuotes = normalized.startsWith('"') && normalized.endsWith('"');
  const hasSingleQuotes = normalized.startsWith("'") && normalized.endsWith("'");
  if (hasDoubleQuotes || hasSingleQuotes) {
    normalized = normalized.slice(1, -1).trim();
  }

  normalized = normalized
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\r\n/g, "\n");

  return normalized;
}

export async function GET(req: NextRequest) {
  const cronAuth = checkAgentCronAuth(req);
  if (!cronAuth.ok) return unauthorizedAgentResponse(cronAuth.error);

  const rawAppId = process.env.GITHUB_APP_ID ?? null;
  const rawInstallId = process.env.GITHUB_INSTALLATION_ID ?? null;
  const rawKey = process.env.GITHUB_APP_PRIVATE_KEY ?? null;

  const keyPresent = rawKey !== null && rawKey.length > 0;
  const keyLength = rawKey?.length ?? 0;
  // Safe preview: first 30 characters only — never enough to reconstruct the key
  const keyFirst30 = rawKey ? rawKey.slice(0, 30) : null;
  const keyContainsLiteralBackslashN = rawKey ? rawKey.includes("\\n") : false;

  let normalizedStartsWithPkcs8 = false;
  let normalizedStartsWithRsa = false;
  let normalizedEndsWithPkcs8 = false;
  let normalizedEndsWithRsa = false;
  let createPrivateKeyOk = false;
  let createPrivateKeyError: string | null = null;

  if (rawKey) {
    const normalized = normalizePrivateKey(rawKey);
    normalizedStartsWithPkcs8 = normalized.startsWith("-----BEGIN PRIVATE KEY-----");
    normalizedStartsWithRsa = normalized.startsWith("-----BEGIN RSA PRIVATE KEY-----");
    normalizedEndsWithPkcs8 = normalized.trimEnd().endsWith("-----END PRIVATE KEY-----");
    normalizedEndsWithRsa = normalized.trimEnd().endsWith("-----END RSA PRIVATE KEY-----");

    try {
      createPrivateKey({ key: normalized, format: "pem" });
      createPrivateKeyOk = true;
    } catch (err: unknown) {
      createPrivateKeyOk = false;
      if (err instanceof Error) {
        // Return only the error code/message — no key material leaks via error text
        createPrivateKeyError = err.message.slice(0, 200);
      } else {
        createPrivateKeyError = "unknown_error";
      }
    }
  }

  return NextResponse.json({
    githubAppIdPresent: rawAppId !== null && rawAppId.length > 0,
    githubInstallationIdPresent: rawInstallId !== null && rawInstallId.length > 0,
    githubAppPrivateKeyPresent: keyPresent,
    githubAppPrivateKeyLength: keyLength,
    githubAppPrivateKeyFirst30: keyFirst30,
    githubAppPrivateKeyContainsLiteralBackslashN: keyContainsLiteralBackslashN,
    normalizedStartsWithPkcs8Header: normalizedStartsWithPkcs8,
    normalizedStartsWithRsaHeader: normalizedStartsWithRsa,
    normalizedEndsWithPkcs8Footer: normalizedEndsWithPkcs8,
    normalizedEndsWithRsaFooter: normalizedEndsWithRsa,
    createPrivateKeyOk,
    createPrivateKeyError,
  });
}
