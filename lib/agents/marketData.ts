import { prisma } from "@/lib/prisma";
import { ensureSp500PriceCache } from "@/lib/benchmark/priceCache";

export interface PricePoint {
  date: Date;
  close: number;
}

const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

/**
 * Daily closes for an arbitrary symbol from Yahoo Finance's public chart
 * endpoint — same source as lib/benchmark/sp500.ts, generalized to any
 * ticker instead of just ^GSPC.
 */
async function fetchYahooHistory(symbol: string, range = "1y"): Promise<PricePoint[]> {
  const url = `${YAHOO_CHART_URL}/${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; portfolio-benchmark/1.0)" },
  });

  if (!response.ok) {
    throw new Error(`Yahoo Finance request failed for ${symbol}: ${response.status} ${response.statusText}`);
  }

  const body = await response.json();
  const result = body?.chart?.result?.[0];
  if (!result) {
    const errorMessage = body?.chart?.error?.description ?? "no result in response";
    throw new Error(`Yahoo Finance returned no data for ${symbol}: ${errorMessage}`);
  }

  const timestamps: number[] = result.timestamp ?? [];
  const closes: Array<number | null> = result.indicators?.quote?.[0]?.close ?? [];

  const points: PricePoint[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (close == null) continue;
    points.push({ date: new Date(timestamps[i] * 1000), close });
  }
  if (points.length === 0) {
    throw new Error(`Yahoo Finance returned no usable closes for ${symbol}`);
  }
  return points;
}

const ALPACA_KEY_ID =
  process.env.ALPACA_API_KEY || process.env.ALPACA_API_KEY_ID || process.env.ALPACA_KEY_ID || "";

const ALPACA_SECRET =
  process.env.ALPACA_SECRET_KEY || process.env.ALPACA_API_SECRET_KEY || process.env.ALPACA_API_SECRET || "";

const ALPACA_DATA_BASE = (process.env.ALPACA_DATA_BASE_URL || "https://data.alpaca.markets").replace(/\/+$/, "");

function hasAlpacaCreds(): boolean {
  return Boolean(ALPACA_KEY_ID && ALPACA_SECRET);
}

/**
 * Daily closes for a symbol from Alpaca's market data API — used only as a
 * fallback when Yahoo Finance is unreachable or rate-limited, since Alpaca
 * requires an account and only covers listed US equities/ETFs (no ^GSPC).
 */
async function fetchAlpacaHistory(symbol: string, days = 400): Promise<PricePoint[]> {
  if (!hasAlpacaCreds()) {
    throw new Error("Alpaca credentials are not configured");
  }

  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    timeframe: "1Day",
    start: start.toISOString(),
    end: end.toISOString(),
    adjustment: "split",
    limit: "1000",
  });

  const url = `${ALPACA_DATA_BASE}/v2/stocks/${encodeURIComponent(symbol)}/bars?${params.toString()}`;
  const response = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID": ALPACA_KEY_ID,
      "APCA-API-SECRET-KEY": ALPACA_SECRET,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Alpaca bars request failed for ${symbol}: ${response.status} ${text}`);
  }

  const body = await response.json();
  const bars: Array<{ t: string; c: number }> = body?.bars ?? [];
  if (bars.length === 0) {
    throw new Error(`Alpaca returned no bars for ${symbol}`);
  }

  return bars.map((bar) => ({ date: new Date(bar.t), close: bar.c }));
}

/** Cached daily ^GSPC closes (see lib/benchmark/priceCache.ts) — the shared S&P 500 baseline series for every portfolio-analysis agent. */
export async function getSp500Series(): Promise<PricePoint[]> {
  await ensureSp500PriceCache();
  const rows = await prisma.benchmarkPrice.findMany({
    orderBy: { date: "desc" },
    take: 300,
  });
  return rows.map((row) => ({ date: row.date, close: row.close })).reverse();
}

export interface PriceHistoryResult {
  symbol: string;
  points: PricePoint[];
  source: "yahoo" | "alpaca";
}

/**
 * Fetches ~1y of daily closes for a symbol, preferring Yahoo Finance and
 * falling back to Alpaca (if credentials are configured) when Yahoo fails —
 * e.g. rate limiting.
 */
export async function getPriceHistory(symbol: string): Promise<PriceHistoryResult> {
  try {
    const points = await fetchYahooHistory(symbol, "1y");
    return { symbol, points, source: "yahoo" };
  } catch (yahooError) {
    if (!hasAlpacaCreds()) throw yahooError;
    const points = await fetchAlpacaHistory(symbol, 400);
    return { symbol, points, source: "alpaca" };
  }
}
