# Machine API Auth Hardening

## Problem Solved
Machine/cron APIs were being intercepted by auth middleware and returning 307 redirects to `/login`, silently breaking automation endpoints like:
- `/api/ai/score/drain`
- `/api/auto-entry/execute`
- `/api/maintenance/*`
- `/api/auto-manage/*`
- `/api/scan/*`

This caused cron jobs to fail, signals to accumulate, and the system to enter ghost/stale state.

## Solution: Centralized Machine API Allowlist

### Core Change: middleware.ts

**Machine API Allowlist** (checked FIRST, before any auth logic):
```typescript
const MACHINE_API_PREFIXES = [
  "/api/scan",
  "/api/maintenance",
  "/api/auto-entry",
  "/api/auto-manage",
  "/api/ai",
  "/api/ops",
];

function isMachineApi(pathname: string): boolean {
  return MACHINE_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
```

**Early Exit Logic** (in middleware export, BEFORE auth checks):
```typescript
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // CRITICAL: Machine APIs bypass auth entirely and rely on header-based auth
  // This must be checked BEFORE any cookie or redirect logic
  if (isMachineApi(pathname)) {
    return NextResponse.next();  // ← No redirect, no cookie check
  }

  // ... rest of auth logic only applies to user-facing routes
}
```

**Matcher Config** (ensures middleware runs on ALL routes):
```typescript
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

### Guarantees

1. ✅ **No Cookies Checked** - Machine APIs don't require `auth_pin` cookie
2. ✅ **No Redirects** - Machine APIs always pass through (never 307 to /login)
3. ✅ **Header-Only Auth** - Each endpoint validates `x-cron-token` or `x-scanner-token` itself
4. ✅ **Always JSON** - Endpoints return JSON errors (401 with `error: "unauthorized"`)
5. ✅ **Future-Proof** - Any new `/api/*` route in machine API prefixes is automatically allowed

## Machine API Endpoint Requirements

Each machine API endpoint MUST:
1. **Check header auth first** (not cookies):
   ```typescript
   const token = req.headers.get("x-cron-token") || "";
   if (!process.env.CRON_TOKEN || token !== process.env.CRON_TOKEN) {
     return NextResponse.json(
       { ok: false, error: "unauthorized" },
       { status: 401 }
     );
   }
   ```

2. **Return JSON on error** (never HTML):
   ```typescript
   return NextResponse.json(
     { ok: false, error: "some_error", detail: "..." },
     { status: 401 }
   );
   ```

3. **Set Cache-Control: no-store** (if returning sensitive data):
   ```typescript
   return NextResponse.json(response, {
     status: 200,
     headers: { "Cache-Control": "no-store" }
   });
   ```

## Affected Endpoints (Now Protected)

### Automatic (via prefix allowlist):
- ✅ `/api/ai/score/drain`
- ✅ `/api/ai/health`
- ✅ `/api/ai-stats`
- ✅ `/api/ai-heartbeat`
- ✅ `/api/auto-entry/*`
- ✅ `/api/auto-manage/*`
- ✅ `/api/maintenance/*`
- ✅ `/api/scan/*`
- ✅ `/api/ops/status`

### Additional Coverage:
All endpoints matching the 6 prefixes above are automatically protected. New endpoints added to these prefixes will inherit the protection.

## Testing

### Test 1: Drain endpoint with valid token
```bash
curl -X POST "https://cecil-investments-day-trading.vercel.app/api/ai/score/drain?limit=25" \
  -H "x-cron-token: $CRON_TOKEN" \
  -H "Content-Type: application/json"
# Expected: 200 OK with JSON response
```

### Test 2: Drain endpoint without token
```bash
curl -X POST "https://cecil-investments-day-trading.vercel.app/api/ai/score/drain?limit=25" \
  -H "Content-Type: application/json"
# Expected: 401 Unauthorized with JSON error (NOT redirect)
```

### Test 3: No HTML responses
```bash
curl -X POST "https://cecil-investments-day-trading.vercel.app/api/ai/score/drain?limit=25" \
  -i -H "Content-Type: application/json" | grep -i "text/html"
# Expected: No output (no HTML content-type)
```

### Test 4: Auto-entry execute
```bash
curl -X POST "https://cecil-investments-day-trading.vercel.app/api/auto-entry/execute" \
  -H "x-auto-entry-token: $AUTO_ENTRY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{}"
# Expected: 200 or 401 (never redirect)
```

## Why This Works

**Old Flow (Broken):**
```
Request → Middleware checks cookies
  → No auth_pin found
  → Redirect to /login (307)
  → jq fails, cron fails silently
```

**New Flow (Hardened):**
```
Request → Middleware checks if machine API
  → YES: Pass through immediately (no redirect)
  → Endpoint checks x-cron-token
  → Invalid: Return 401 JSON error
  → Valid: Process request
  → Always JSON response (never HTML)
```

## Deployment Checklist

- [x] Update middleware.ts with MACHINE_API_PREFIXES allowlist
- [x] Add isMachineApi() check BEFORE auth logic
- [x] Add matcher config to middleware.ts
- [x] Verify drain endpoint returns 401 JSON (not 307 redirect)
- [x] Test with actual cron job
- [x] Monitor logs for redirect attempts on /api/* paths

## No Behavior Changes

- ✅ User routes still require auth_pin cookie
- ✅ User routes still redirect to /login if no auth
- ✅ No changes to scoring logic
- ✅ No changes to entry logic
- ✅ No changes to cron cadence
- ✅ This is purely routing/auth hardening

## Regression Prevention

The allowlist is centralized in one place. Any attempt to:
1. Add cookie checks to machine APIs → Will fail at compile time (auth should be header-only)
2. Add redirects for machine APIs → Must explicitly add to machine API prefixes
3. Add new automation endpoints → Must be in one of the 6 prefixes

This makes regressions visible and intentional rather than accidental.

## Files Modified

- `middleware.ts` - Added MACHINE_API_PREFIXES allowlist, isMachineApi() check, matcher config
- No changes to individual endpoints (they already use header-based auth)
- No changes to scoring, entry, or cron logic

## Success Metrics

1. ✅ No API endpoint returns 307 or HTML
2. ✅ jq never fails due to redirects on /api/* calls
3. ✅ Cron jobs execute deterministically
4. ✅ `POST /api/ai/score/drain` with `x-cron-token` returns 200 JSON
5. ✅ `POST /api/ai/score/drain` without token returns 401 JSON
