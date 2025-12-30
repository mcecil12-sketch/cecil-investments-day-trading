"use server";

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PATHS = [
  "/api/auto-entry",
  "/login",
  "/api/login",
  "/api/ai-stats",
  "/api/ai-health",
  "/api/funnel-stats",
  "/api/ai-heartbeat",
  "/api/diag-build",
  "/api/locks",
];

function isScannerAuthed(req: NextRequest) {
  const token = process.env.SCANNER_TOKEN;
  if (!token) return false;
  const header = req.headers.get("x-scanner-token");
  return Boolean(header && header === token);
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

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

  const authPin = req.cookies.get("auth_pin")?.value;
  if (!authPin) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("from", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}
