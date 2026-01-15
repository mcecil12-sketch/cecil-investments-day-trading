import { NextResponse } from "next/server";
import { readTrades } from "@/lib/tradesStore";

export const dynamic = "force-dynamic";

type TradeStatus = "OPEN" | "CLOSED" | "PENDING" | "PARTIAL" | string;

type Trade = {
  status: TradeStatus;
  realizedPnL?: number | null;
  closedAt?: string;
  updatedAt?: string;
  createdAt?: string;
};

/**
 * Convert an ISO timestamp to America/New_York trading day (YYYY-MM-DD)
 */
function dateETFromISO(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value || "1970";
  const m = parts.find((p) => p.type === "month")?.value || "01";
  const da = parts.find((p) => p.type === "day")?.value || "01";
  return `${y}-${m}-${da}`;
}

/**
 * Convert a YYYY-MM-DD date string to a Date at UTC 00:00:00
 */
function parseDateET(s: string): Date {
  const [y, m, d] = s.split("-").map((x) => parseInt(x, 10));
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1, 0, 0, 0, 0));
}

/**
 * Get the current trading day in America/New_York timezone
 */
function getNowET(): string {
  return dateETFromISO(new Date().toISOString());
}

/**
 * Add days to a YYYY-MM-DD date string
 */
function addDaysET(dateET: string, days: number): string {
  const dt = parseDateET(dateET);
  dt.setUTCDate(dt.getUTCDate() + days);
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Get start date based on range in America/New_York timezone
 */
function getStartDateET(range: string): string | null {
  const nowET = getNowET();
  if (range === "today") return nowET;
  if (range === "week") return addDaysET(nowET, -7);
  if (range === "month") return addDaysET(nowET, -30);
  return null; // "all"
}

/**
 * REALIZED MODE: Calculate daily PnL from closed trades
 */
async function dailyRealized(range: string): Promise<Response> {
  const trades = await readTrades<Trade>();
  const startET = getStartDateET(range);
  const nowET = getNowET();

  // Filter: CLOSED trades with valid realizedPnL
  const closed = trades.filter(
    (t) =>
      (t.status || "").toUpperCase() === "CLOSED" &&
      typeof t.realizedPnL === "number" &&
      Number.isFinite(t.realizedPnL)
  );

  // Group by close date (NY trading day)
  const dailyMap = new Map<string, number>();

  for (const trade of closed) {
    const closeTS = trade.closedAt || trade.updatedAt || trade.createdAt;
    if (!closeTS) continue;

    const dateET = dateETFromISO(closeTS);

    // Apply range filter
    if (startET && dateET < startET) continue;
    if (dateET > nowET) continue;

    const pnl = trade.realizedPnL as number;
    dailyMap.set(dateET, (dailyMap.get(dateET) || 0) + pnl);
  }

  // Sort by date and format response
  const daily = Array.from(dailyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, pnl]) => ({ date, pnl }));

  return NextResponse.json(
    { ok: true, mode: "realized", range, daily },
    { status: 200 }
  );
}

/**
 * Fetch latest equity value for a given NY trading day
 */
async function fetchEquityForDateET(
  origin: string,
  dateET: string
): Promise<number | null> {
  try {
    const url = `${origin}/api/performance/equity?limit=500&dateET=${encodeURIComponent(
      dateET
    )}&_=${Date.now()}`;
    const resp = await fetch(url, { cache: "no-store" });
    if (!resp.ok) return null;

    const json: any = await resp.json().catch(() => null);
    if (!json) return null;

    const equity = json?.latest?.equity;
    const num =
      typeof equity === "string"
        ? Number(equity)
        : typeof equity === "number"
          ? equity
          : NaN;

    return Number.isFinite(num) ? num : null;
  } catch {
    return null;
  }
}

/**
 * Determine request origin for internal API calls
 */
function getOrigin(req: Request): string {
  const headers = req.headers;
  const proto = headers.get("x-forwarded-proto") || "https";
  const host = headers.get("x-forwarded-host") || headers.get("host");

  if (host) return `${proto}://${host}`;

  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL || process.env.VERCEL_URL || "";
  if (baseUrl.startsWith("http://") || baseUrl.startsWith("https://"))
    return baseUrl;
  if (baseUrl) return `https://${baseUrl}`;

  return "http://localhost:3000";
}

/**
 * EQUITY MODE (MTM): Calculate daily PnL from equity snapshots
 */
async function dailyEquity(req: Request, range: string): Promise<Response> {
  const nowET = getNowET();
  const startET = getStartDateET(range);
  const origin = getOrigin(req);

  // Build list of dates to fetch
  const dates: string[] = [];
  if (startET) {
    let d = startET;
    while (d <= nowET) {
      dates.push(d);
      d = addDaysET(d, 1);
    }
  } else {
    // range === "all" - look back 60 days
    for (let i = 60; i >= 0; i--) {
      dates.push(addDaysET(nowET, -i));
    }
  }

  // Fetch equity for each date and calculate daily PnL
  const daily: Array<{ date: string; pnl: number }> = [];
  let prevEquity: number | null = null;

  for (const dateET of dates) {
    const equity = await fetchEquityForDateET(origin, dateET);
    if (equity === null) {
      prevEquity = null;
      continue;
    }

    // Skip if we don't have a prior day's equity
    if (prevEquity === null) {
      prevEquity = equity;
      // For "today" range, include first day with pnl=0
      if (range === "today") {
        daily.push({ date: dateET, pnl: 0 });
      }
      continue;
    }

    daily.push({ date: dateET, pnl: equity - prevEquity });
    prevEquity = equity;
  }

  return NextResponse.json(
    { ok: true, mode: "equity", range, daily },
    { status: 200 }
  );
}

/**
 * GET /api/performance/daily
 *
 * Query params:
 *   - range: "today" | "week" | "month" | "all" (default: "all")
 *   - mode: "realized" | "equity" (default: "realized")
 */
export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const range = (url.searchParams.get("range") || "all").toLowerCase();
    const mode = (url.searchParams.get("mode") || "realized").toLowerCase();

    // Validate inputs
    const validRanges = ["today", "week", "month", "all"];
    if (!validRanges.includes(range)) {
      return NextResponse.json(
        { ok: false, error: "Invalid range", detail: `Must be one of: ${validRanges.join(", ")}` },
        { status: 400 }
      );
    }

    const validModes = ["realized", "equity"];
    if (!validModes.includes(mode)) {
      return NextResponse.json(
        { ok: false, error: "Invalid mode", detail: `Must be one of: ${validModes.join(", ")}` },
        { status: 400 }
      );
    }

    if (mode === "equity") {
      return await dailyEquity(req, range);
    }

    return await dailyRealized(range);
  } catch (err: any) {
    return NextResponse.json(
      {
        ok: false,
        error: "Failed to load daily performance",
        detail: err?.message ?? String(err),
      },
      { status: 500 }
    );
  }
}
