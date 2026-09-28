import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/auth/session";

// Next.js always runs middleware in the Edge Runtime (even on Next 14, with
// no opt-out) — lib/auth/session.ts is written against Web Crypto so it
// works here as well as in the Node-runtime /api/auth/* routes.
const PUBLIC_PATHS = ["/signin"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.includes(pathname) || pathname.startsWith("/api/auth/");
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const authenticated = await verifySessionToken(token);
  if (authenticated) {
    return NextResponse.next();
  }

  // A JSON 401 for API routes rather than a redirect: a fetch() call
  // following a redirect to /signin would receive the sign-in page's HTML
  // instead of JSON, which every API caller in this app expects.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Not authenticated" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.redirect(new URL("/signin", request.url));
}

export const config = {
  // Exclude Next's own static/image assets — anything else (pages and
  // /api/* alike) goes through the auth check above.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
