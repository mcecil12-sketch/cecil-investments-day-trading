import { prisma } from "@/lib/prisma";
import {
  fetchInsiderTransactionsDetailed,
  summarizeInsiderActivity,
  type InsiderFetchResult,
  type InsiderRawRow,
  INSIDER_MAX_CALLS_PER_RUN,
  INSIDER_PACING_MS,
  INSIDER_WINDOW_DAYS,
  type InsiderSource,
  type InsiderSummary,
} from "@/lib/agents/insiderActivity";
import { fetchInsiderWithFallback } from "@/lib/agents/insiderSources";
import { computeMarketCap, fetchOverview, pctOfMarketCap, type MarketCapSource, type OverviewResult } from "@/lib/agents/marketCap";

/** Wall-clock budget for the insider pass, measured from the start of the function (route) that runs it — the routes' maxDuration is 240s; this leaves room for the final writes/health record. Same idea as the sentiment job's 225s guard. */
export const INSIDER_PASS_DEADLINE_MS = 200_000;

/** Don't start a call unless this much budget remains (one paced wait + a slow Alpha Vantage response). */
const CALL_HEADROOM_MS = 20_000;

export interface InsiderPassCounters {
  insiderCallsUsed: number;
  /** Calls that returned at least one transaction row. */
  insiderSucceeded: number;
  /** Alpha Vantage valid responses with ZERO rows — "attempted, no data" (could be no coverage rather than no insider activity). */
  insiderEmpty: number;
  /** EDGAR valid results with no Form 4 sales (or purchases) in the window — stored as $0 and labelled "no filings". */
  insiderNoFilings: number;
  insiderFailed: number;
  insiderSkippedByDeadline: number;
  deadlineHit: boolean;
  /** Total HTTP requests made by the pass (EDGAR submissions + filings + any Alpha Vantage fallback), and per-source ticker counts. */
  insiderRequests: number;
  insiderFromEdgar: number;
  insiderFromAlphaVantage: number;
  elapsedMs: number;
}

/** Per-ticker diagnostics, returned by dry runs. null/0 fields mean the call failed. */
export interface InsiderTickerDiagnostics {
  symbol: string;
  status: "ok" | "no_filings" | "empty" | "failed";
  failureReason: string | null;
  rowsReturned: number;
  rowsInWindow: number;
  saleRowsCounted: number;
  /** null when failed or empty (renders as "n/a"); 0 for EDGAR "no filings" (a real, valid zero). */
  netSoldUsd: number | null;
  responseKeys: string[];
  /** Which source supplied the rows (null when both failed). */
  source: InsiderSource | null;
  /** Why EDGAR was not used for this ticker (set when Alpha Vantage supplied the data or both failed). */
  edgarFailure: string | null;
  requests: number;
  filings: number | null;
  /** Sale dollars flagged as Rule 10b5-1 plan sales (null when the source has no indicator). */
  plannedSalesUsd: number | null;
  elapsedMs: number;
}

export interface InsiderPassItem {
  id: string;
  symbol: string;
  /** Known market cap for this row (enables insiderNetSoldPctOfMarketCap when the insider result lands). */
  marketCap?: number | null;
}

export interface InsiderPassOptions {
  /** Epoch ms the enclosing function started; the deadline is measured from here. */
  startedAtMs?: number;
  deadlineMs?: number;
  asOf?: Date;
  /** Injected for tests; defaults to the real Alpha Vantage fetch. null = failure, [] = no transactions. */
  fetchRows?: (symbol: string, from: Date, ctx: { deadlineAtMs: number }) => Promise<InsiderRawRow[] | null | InsiderFetchResult>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Called right after each attempted symbol (summary null on failure) — the persistence hook, so progress survives a later timeout. */
  onResult?: (item: InsiderPassItem, summary: InsiderSummary | null, meta: { source: InsiderSource | null }) => Promise<void>;
}

/**
 * Sequential, paced insider fetch over `items`. Stops cleanly (never throws)
 * when the deadline is near or the call budget is spent; everything not
 * attempted is counted in insiderSkippedByDeadline and left untouched.
 */
export async function runInsiderPass(items: InsiderPassItem[], options: InsiderPassOptions = {}): Promise<InsiderPassCounters & { summaries: Map<string, InsiderSummary | null>; diagnostics: InsiderTickerDiagnostics[] }> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchRows = options.fetchRows ?? ((symbol: string, from: Date, ctx: { deadlineAtMs: number }) => fetchInsiderWithFallback(symbol, from, { deadlineAtMs: ctx.deadlineAtMs, now }));
  const startedAt = options.startedAtMs ?? now();
  const deadline = options.deadlineMs ?? INSIDER_PASS_DEADLINE_MS;
  const asOf = options.asOf ?? new Date();
  const from = new Date(asOf.getTime() - INSIDER_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const counters: InsiderPassCounters = { insiderCallsUsed: 0, insiderSucceeded: 0, insiderEmpty: 0, insiderNoFilings: 0, insiderFailed: 0, insiderSkippedByDeadline: 0, deadlineHit: false, insiderRequests: 0, insiderFromEdgar: 0, insiderFromAlphaVantage: 0, elapsedMs: 0 };
  let lastSource: InsiderSource | null = null;
  const diagnostics: InsiderTickerDiagnostics[] = [];
  const summaries = new Map<string, InsiderSummary | null>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const elapsed = now() - startedAt;
    if (elapsed + CALL_HEADROOM_MS > deadline || counters.insiderCallsUsed >= INSIDER_MAX_CALLS_PER_RUN) {
      counters.deadlineHit = counters.deadlineHit || elapsed + CALL_HEADROOM_MS > deadline;
      counters.insiderSkippedByDeadline = items.length - i;
      break;
    }
    // Alpha Vantage needs its own pacing; the EDGAR client rate-limits itself.
    if (counters.insiderCallsUsed > 0 && lastSource !== "edgar") await sleep(INSIDER_PACING_MS);
    const tickerStart = now();
    counters.insiderCallsUsed++;

    let summary: InsiderSummary | null = null;
    const diag: InsiderTickerDiagnostics = { symbol: item.symbol, status: "failed", failureReason: null, rowsReturned: 0, rowsInWindow: 0, saleRowsCounted: 0, netSoldUsd: null, responseKeys: [], source: null, edgarFailure: null, requests: 0, filings: null, plannedSalesUsd: null, elapsedMs: 0 };
    let aborted = false;
    try {
      const raw = await fetchRows(item.symbol, from, { deadlineAtMs: startedAt + deadline - 1_000 });
      const result: InsiderFetchResult = Array.isArray(raw)
        ? { ok: true, rows: raw, responseKeys: [] }
        : raw == null
          ? { ok: false, reason: "fetch returned null", responseKeys: [] }
          : raw;
      diag.responseKeys = result.responseKeys;
      diag.requests = result.meta?.requests ?? 0;
      if (!result.ok) {
        if (result.aborted) aborted = true;
        diag.failureReason = result.reason;
      } else {
        diag.source = result.source ?? null;
        diag.edgarFailure = result.meta?.edgarFailure ?? null;
        diag.filings = result.meta?.filings ?? null;
        const s = summarizeInsiderActivity(result.rows, asOf, result.fields);
        diag.rowsReturned = s.rowsReturned;
        diag.rowsInWindow = s.rowsInWindow;
        diag.saleRowsCounted = s.insiderSaleCount30d;
        diag.plannedSalesUsd = s.plannedSalesUsd;
        if (result.source === "edgar" && s.insiderSaleCount30d === 0 && s.insiderNetSoldUsd30d === 0) {
          // EDGAR answered authoritatively and there were no S/P Form 4 transactions in the window: a real $0, labelled "no filings".
          diag.status = "no_filings";
          diag.netSoldUsd = 0;
          summary = s;
        } else if (s.rowsReturned === 0) {
          // Alpha Vantage valid-but-empty: coverage unknown, so n/a rather than "$0 sold".
          diag.status = "empty";
        } else {
          diag.status = "ok";
          diag.netSoldUsd = s.insiderNetSoldUsd30d;
          summary = s;
        }
      }
    } catch (err) {
      diag.failureReason = err instanceof Error ? err.message.slice(0, 120) : "error";
    }
    diag.elapsedMs = now() - tickerStart;
    counters.insiderRequests += diag.requests;
    if (aborted) {
      // Out of time mid-ticker: leave this and the rest unattempted for a resumed pass.
      counters.insiderCallsUsed--;
      counters.deadlineHit = true;
      counters.insiderSkippedByDeadline = items.length - i;
      break;
    }
    lastSource = diag.source;
    if (diag.source === "edgar") counters.insiderFromEdgar++;
    else if (diag.source === "alphavantage") counters.insiderFromAlphaVantage++;
    if (diag.status === "ok") counters.insiderSucceeded++;
    else if (diag.status === "no_filings") counters.insiderNoFilings++;
    else if (diag.status === "empty") counters.insiderEmpty++;
    else counters.insiderFailed++;
    summaries.set(item.symbol, summary);
    diagnostics.push(diag);

    try {
      await options.onResult?.(item, summary, { source: diag.source });
    } catch (err) {
      console.error(`[insider] persisting ${item.symbol} failed:`, err instanceof Error ? err.message : err);
    }
  }
  counters.elapsedMs = now() - startedAt;
  return { ...counters, summaries, diagnostics };
}

export interface MarketCapCounters {
  marketCapAttempted: number;
  marketCapOk: number;
  marketCapFailed: number;
  marketCapSkippedByDeadline: number;
}

export interface MarketCapPassItem {
  id: string;
  symbol: string;
  scanClose: number | null;
  insiderNetSoldUsd30d: number | null;
}

/**
 * Sequential, paced market-cap lookups (Alpha Vantage OVERVIEW). Same
 * contract as the insider pass: stops cleanly at the deadline, never throws,
 * persists per row via onResult.
 */
export async function runMarketCapPass(
  items: MarketCapPassItem[],
  options: {
    startedAtMs?: number;
    deadlineMs?: number;
    fetchOverviewFn?: (symbol: string) => Promise<OverviewResult>;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    onResult?: (item: MarketCapPassItem, r: { marketCap: number | null; source: MarketCapSource; pct: number | null }) => Promise<void>;
  } = {},
): Promise<MarketCapCounters & { results: Map<string, { marketCap: number | null; source: MarketCapSource; pct: number | null }> }> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchOv = options.fetchOverviewFn ?? ((symbol: string) => fetchOverview(symbol));
  const startedAt = options.startedAtMs ?? now();
  const deadline = options.deadlineMs ?? INSIDER_PASS_DEADLINE_MS;
  const counters: MarketCapCounters = { marketCapAttempted: 0, marketCapOk: 0, marketCapFailed: 0, marketCapSkippedByDeadline: 0 };
  const results = new Map<string, { marketCap: number | null; source: MarketCapSource; pct: number | null }>();

  for (let i = 0; i < items.length; i++) {
    if (now() - startedAt + INSIDER_PACING_MS + 8_000 > deadline) {
      counters.marketCapSkippedByDeadline = items.length - i;
      break;
    }
    if (counters.marketCapAttempted > 0) await sleep(INSIDER_PACING_MS);
    counters.marketCapAttempted++;
    const item = items[i];
    let overview: OverviewResult;
    try {
      overview = await fetchOv(item.symbol);
    } catch (err) {
      overview = { ok: false, reason: err instanceof Error ? err.message : "error" };
    }
    const { marketCap, source } = computeMarketCap(overview, item.scanClose);
    const r = { marketCap, source, pct: pctOfMarketCap(item.insiderNetSoldUsd30d, marketCap) };
    if (marketCap != null) counters.marketCapOk++;
    else counters.marketCapFailed++;
    results.set(item.symbol, r);
    try {
      await options.onResult?.(item, r);
    } catch (err) {
      console.error(`[marketcap] persisting ${item.symbol} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return { ...counters, results };
}

export interface EnrichResult extends InsiderPassCounters, MarketCapCounters {
  batchTag: string | null;
  rowsConsidered: number;
  error?: string;
}

/**
 * Second pass of the monthly scan: fills in insider fields (and the market
 * cap behind insiderNetSoldPctOfMarketCap) on the latest monthly batch's rows.
 * Idempotent and resumable — only touches rows whose insiderFetchedAt (or
 * marketCapSource) is null (retryFailed also re-attempts rows that came back
 * with no data / an unavailable market cap), so a partial run can be completed
 * without re-running the scan. insiderFetchedAt is set for every row
 * attempted, including failures, so "not attempted" stays distinguishable.
 * Never throws.
 */
export async function enrichInsiderForLatestMonthlyScan(
  options: InsiderPassOptions & { retryFailed?: boolean; /** Restrict to rows written by this scan run (the cron path); omitted = latest batch. */ sourceAgentRunId?: string; fetchOverviewFn?: (symbol: string) => Promise<OverviewResult> } = {},
): Promise<EnrichResult> {
  const empty: EnrichResult = { batchTag: null, rowsConsidered: 0, insiderCallsUsed: 0, insiderSucceeded: 0, insiderEmpty: 0, insiderNoFilings: 0, insiderFailed: 0, insiderSkippedByDeadline: 0, deadlineHit: false, insiderRequests: 0, insiderFromEdgar: 0, insiderFromAlphaVantage: 0, elapsedMs: 0, marketCapAttempted: 0, marketCapOk: 0, marketCapFailed: 0, marketCapSkippedByDeadline: 0 };
  try {
    const latest = await prisma.candidateRecommendationLog.findFirst({
      where: { group: "GROUP_3", ...(options.sourceAgentRunId ? { sourceAgentRunId: options.sourceAgentRunId } : {}) },
      orderBy: { recommendedAt: "desc" },
      select: { batchTag: true },
    });
    if (!latest) return empty;
    const scope = { group: "GROUP_3" as const, batchTag: latest.batchTag, ...(options.sourceAgentRunId ? { sourceAgentRunId: options.sourceAgentRunId } : {}) };

    const rows = await prisma.candidateRecommendationLog.findMany({
      where: {
        ...scope,
        ...(options.retryFailed
          ? { OR: [{ insiderFetchedAt: null }, { insiderNetSoldUsd30d: null }] }
          : { insiderFetchedAt: null }),
      },
      orderBy: { rank: "asc" },
      select: { id: true, symbol: true, marketCap: true },
    });

    const startedAtMs = options.startedAtMs ?? (options.now ?? Date.now)();
    const result = await runInsiderPass(rows, {
      ...options,
      startedAtMs,
      onResult: async (item, summary, meta) => {
        await prisma.candidateRecommendationLog.update({
          where: { id: item.id },
          data: {
            insiderFetchedAt: new Date(),
            insiderSource: meta.source,
            ...(summary
              ? {
                  insiderNetSoldUsd30d: summary.insiderNetSoldUsd30d,
                  insiderSaleCount30d: summary.insiderSaleCount30d,
                  insiderSellers30d: summary.insiderSellers30d,
                  insiderHas10b5_1: summary.insiderHas10b5_1,
                  insiderNetSoldPctOfMarketCap: pctOfMarketCap(summary.insiderNetSoldUsd30d, item.marketCap ?? null),
                }
              : {}),
          },
        });
      },
    });
    const { summaries: _s, diagnostics: _d, ...counters } = result;
    void _s;
    void _d;

    // Market caps, with whatever budget is left (insider data is the more valuable pass, so it goes first).
    const capRows = await prisma.candidateRecommendationLog.findMany({
      where: { ...scope, ...(options.retryFailed ? { OR: [{ marketCapSource: null }, { marketCapSource: "unavailable" }] } : { marketCapSource: null }) },
      orderBy: { rank: "asc" },
      select: { id: true, symbol: true, scanClose: true, insiderNetSoldUsd30d: true },
    });
    const cap = await runMarketCapPass(capRows, {
      startedAtMs,
      deadlineMs: options.deadlineMs,
      sleep: options.sleep,
      now: options.now,
      fetchOverviewFn: options.fetchOverviewFn,
      onResult: async (item, r) => {
        await prisma.candidateRecommendationLog.update({
          where: { id: item.id },
          data: { marketCap: r.marketCap, marketCapSource: r.source, ...(r.pct != null ? { insiderNetSoldPctOfMarketCap: r.pct } : {}) },
        });
      },
    });
    const { results: _r, ...capCounters } = cap;
    void _r;
    return { ...counters, ...capCounters, batchTag: latest.batchTag, rowsConsidered: rows.length };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) };
  }
}
