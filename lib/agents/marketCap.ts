/**
 * Market cap at scan time, logging-only: Alpha Vantage OVERVIEW SharesOutstanding
 * x the close the scan used (so the cap is tied to a known price date), falling
 * back to OVERVIEW's own MarketCapitalization when shares are missing. Lets the
 * Performance Analyst express insider selling relative to company size.
 */
const ALPHA_VANTAGE_BASE_URL = "https://www.alphavantage.co/query";

export type MarketCapSource = "shares_x_close" | "av_reported" | "unavailable";

export type OverviewResult =
  | { ok: true; sharesOutstanding: number | null; reportedMarketCap: number | null }
  | { ok: false; reason: string };

function positive(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** One OVERVIEW call. Information/Note/Error Message bodies and HTTP errors are failures; never throws. */
export async function fetchOverview(symbol: string, fetchFn: typeof fetch = fetch): Promise<OverviewResult> {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) return { ok: false, reason: "ALPHA_VANTAGE_API_KEY is not configured" };
  try {
    const res = await fetchFn(`${ALPHA_VANTAGE_BASE_URL}?function=OVERVIEW&symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`, { cache: "no-store" });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const body = (await res.json()) as Record<string, unknown>;
    for (const key of ["Information", "Note", "Error Message"]) {
      if (body && body[key]) return { ok: false, reason: `${key}: ${String(body[key]).slice(0, 100)}` };
    }
    return { ok: true, sharesOutstanding: positive(body?.SharesOutstanding), reportedMarketCap: positive(body?.MarketCapitalization) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message.slice(0, 100) : "network error" };
  }
}

export function computeMarketCap(
  overview: OverviewResult,
  scanClose: number | null,
): { marketCap: number | null; source: MarketCapSource } {
  if (!overview.ok) return { marketCap: null, source: "unavailable" };
  if (overview.sharesOutstanding != null && scanClose != null && scanClose > 0) {
    return { marketCap: overview.sharesOutstanding * scanClose, source: "shares_x_close" };
  }
  if (overview.reportedMarketCap != null) return { marketCap: overview.reportedMarketCap, source: "av_reported" };
  return { marketCap: null, source: "unavailable" };
}

/** Net insider selling as a percent of market cap (positive = net selling); null unless both inputs are known and the cap is positive. */
export function pctOfMarketCap(netSoldUsd: number | null, marketCap: number | null): number | null {
  if (netSoldUsd == null || marketCap == null || !(marketCap > 0)) return null;
  return (netSoldUsd / marketCap) * 100;
}
