import {
  fetchInsiderTransactionsDetailed,
  type InsiderFetchResult,
} from "@/lib/agents/insiderActivity";
import { defaultEdgarClient, fetchEdgarInsider, type EdgarClient } from "@/lib/agents/edgarInsider";

export interface InsiderFetchContext {
  /** Absolute epoch-ms deadline; EDGAR aborts cleanly mid-ticker when it passes. */
  deadlineAtMs?: number;
  now?: () => number;
  client?: EdgarClient;
  /** Injected for tests; defaults to the real Alpha Vantage call. */
  alphaVantage?: (symbol: string, from: Date) => Promise<InsiderFetchResult>;
}

/**
 * EDGAR first, Alpha Vantage as the per-ticker fallback.
 * - EDGAR ok (including a valid empty result) -> that is the answer; no fallback.
 * - EDGAR failed (not configured, ticker not found, non-200, throttled,
 *   unparseable) -> try Alpha Vantage for that ticker; the EDGAR reason is kept
 *   in meta.edgarFailure.
 * - Both failed -> FAILED, with both reasons.
 * - EDGAR hit the time budget mid-ticker -> aborted (left unattempted), no fallback.
 */
export async function fetchInsiderWithFallback(symbol: string, from: Date, ctx: InsiderFetchContext = {}): Promise<InsiderFetchResult> {
  const edgar = await fetchEdgarInsider(ctx.client ?? defaultEdgarClient, symbol, from, { deadlineAtMs: ctx.deadlineAtMs, now: ctx.now });
  if (edgar.ok) return edgar;
  if (edgar.aborted) return edgar;

  const av = await (ctx.alphaVantage ?? fetchInsiderTransactionsDetailed)(symbol, from);
  const requests = edgar.meta?.requests;
  if (av.ok) {
    return { ...av, source: "alphavantage", meta: { ...(av.meta ?? {}), requests, edgarFailure: edgar.reason } };
  }
  return { ok: false, reason: `EDGAR: ${edgar.reason}; Alpha Vantage: ${av.reason}`, responseKeys: av.responseKeys, meta: { requests } };
}
