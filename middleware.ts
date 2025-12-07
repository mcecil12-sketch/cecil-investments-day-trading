import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const PUBLIC_PATHS = ["/login", "/api/login", "/favicon.ico"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Allow next internals and static assets
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/api/health") || // if you add a healthcheck
    PUBLIC_PATHS.includes(pathname)
  ) {
    return NextResponse.next();
  }

  const authCookie = req.cookies.get("auth_pin")?.value;

  if (authCookie === "1") {
    return NextResponse.next();
  }

  // Not authenticated -> redirect to /login
  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("from", pathname);
  return NextResponse.redirect(loginUrl);
}

// Match everything except static files, but we already guard in middleware above
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
