"use server";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * MACHINE API ALLOWLIST
 * These automation endpoints bypass cookie auth and rely on header-based auth only.
 * Each endpoint must validate its own tokens (x-cron-token, x-scanner-token, etc).
 */
const MACHINE_API_PREFIXES = [
  "/api/scan",
  "/api/maintenance",
  "/api/auto-entry",
  "/api/auto-manage",
  "/api/ai",
  "/api/ops",
];

const PUBLIC_PATHS = [
  '/api/readiness',
  "/api/auto-entry",
  "/api/cron",
  "/login",
  "/api/login",
  "/api/ai-stats",
  "/api/ai-health",
  "/api/ai-scoreboard",
  "/api/funnel-stats",
  "/api/ai-heartbeat",
  "/api/diag-build",
  "/api/locks",
  "/api/ops/status",
  "/api/performance/snapshot",
  "/api/performance/equity",
  "/api/performance/analytics",
  "/api/performance/trades",
  "/api/performance/daily",
  "/api/performance/portfolio",
  "/api/maintenance/auto-entry-reset-failures",
  "/api/maintenance/disable-trade",
  "/api/trades",
  "/api/trades/summary",
  "/api/trades/manage",
  "/api/trades/execute",
  "/api/trades/approve",
  "/api/trades/apply-stop",
  "/api/signals",
  "/api/signals/all",
  "/api/scorecard",
  "/api/scan",
  "/api/scan/health",
  "/api/ai/health",
];

function isMachineApi(pathname: string): boolean {
  return MACHINE_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isCronAuthed(req: NextRequest) {
  const token = process.env.CRON_TOKEN;
  if (!token) return false;
  const header = req.headers.get("x-cron-token");
  return Boolean(header && header === token);
}

function isScannerAuthed(req: NextRequest) {
  const token = process.env.SCANNER_TOKEN;
  if (!token) return false;
  const header = req.headers.get("x-scanner-token");
  return Boolean(header && header === token);
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // CRITICAL: Machine APIs bypass auth entirely and rely on header-based auth
  // This must be checked BEFORE any cookie or redirect logic
  if (isMachineApi(pathname)) {
    return NextResponse.next();
  }

  const scannerToken = req.headers.get("x-scanner-token") || "";
  const expectedScannerToken = process.env.SCANNER_TOKEN || "";
  if (
    expectedScannerToken &&
    scannerToken &&
    scannerToken === expectedScannerToken &&
    (pathname.startsWith("/api/scan") || pathname.startsWith("/api/signals"))
  ) {
    return NextResponse.next();
  }

  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api/health") ||
    PUBLIC_PATHS.some((p) => pathname.startsWith(p))
  ) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/scan") && isScannerAuthed(req)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/maintenance/") && isCronAuthed(req)) {
    return NextResponse.next();
  }

  if (pathname === "/api/auto-manage/run" && isCronAuthed(req)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/debug-context") && (isCronAuthed(req) || isScannerAuthed(req))) {
    return NextResponse.next();
  }

  const authPin = req.cookies.get("auth_pin")?.value;
  if (!authPin) {
    // For API paths without auth, return 401 JSON instead of redirect
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { ok: false, error: "unauthorized", message: "Missing authentication credentials" },
        { status: 401, headers: { "Cache-Control": "no-store" } }
      );
    }
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("from", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
