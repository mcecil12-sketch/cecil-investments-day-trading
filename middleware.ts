import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PATHS = [
  "/login",
  "/api/login",
  "/api/ai-stats",
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const authPin = req.cookies.get("auth_pin")?.value;
  if (!authPin) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  return NextResponse.next();
}
