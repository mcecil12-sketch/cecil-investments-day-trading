import { prisma } from "@/lib/prisma";
import {
  fetchInsiderTransactionsDetailed,
  summarizeInsiderActivity,
  type InsiderFetchResult,
  type InsiderRawRow,
  INSIDER_MAX_CALLS_PER_RUN,
  INSIDER_PACING_MS,
  INSIDER_WINDOW_DAYS,
  type InsiderSummary,
} from "@/lib/agents/insiderActivity";

/** Wall-clock budget for the insider pass, measured from the start of the function (route) that runs it — the routes' maxDuration is 240s; this leaves room for the final writes/health record. Same idea as the sentiment job's 225s guard. */
export const INSIDER_PASS_DEADLINE_MS = 200_000;

/** Don't start a call unless this much budget remains (one paced wait + a slow Alpha Vantage response). */
const CALL_HEADROOM_MS = INSIDER_PACING_MS + 8_000;

export interface InsiderPassCounters {
  insiderCallsUsed: number;
  /** Calls that returned at least one transaction row. */
  insiderSucceeded: number;
  /** Calls that were valid responses with ZERO rows — "attempted, no data" (could be no coverage rather than no insider activity). */
  insiderEmpty: number;
  insiderFailed: number;
  insiderSkippedByDeadline: number;
  deadlineHit: boolean;
}

/** Per-ticker diagnostics, returned by dry runs. null/0 fields mean the call failed. */
export interface InsiderTickerDiagnostics {
  symbol: string;
  status: "ok" | "empty" | "failed";
  failureReason: string | null;
  rowsReturned: number;
  rowsInWindow: number;
  saleRowsCounted: number;
  /** null when failed or empty (renders as "n/a"), never 0-by-default. */
  netSoldUsd: number | null;
  responseKeys: string[];
}

export interface InsiderPassItem {
  id: string;
  symbol: string;
}

export interface InsiderPassOptions {
  /** Epoch ms the enclosing function started; the deadline is measured from here. */
  startedAtMs?: number;
  deadlineMs?: number;
  asOf?: Date;
  /** Injected for tests; defaults to the real Alpha Vantage fetch. null = failure, [] = no transactions. */
  fetchRows?: (symbol: string, from: Date) => Promise<InsiderRawRow[] | null | InsiderFetchResult>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Called right after each attempted symbol (summary null on failure) — the persistence hook, so progress survives a later timeout. */
  onResult?: (item: InsiderPassItem, summary: InsiderSummary | null) => Promise<void>;
}

/**
 * Sequential, paced insider fetch over `items`. Stops cleanly (never throws)
 * when the deadline is near or the call budget is spent; everything not
 * attempted is counted in insiderSkippedByDeadline and left untouched.
 */
export async function runInsiderPass(items: InsiderPassItem[], options: InsiderPassOptions = {}): Promise<InsiderPassCounters & { summaries: Map<string, InsiderSummary | null>; diagnostics: InsiderTickerDiagnostics[] }> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchRows = options.fetchRows ?? fetchInsiderTransactionsDetailed;
  const startedAt = options.startedAtMs ?? now();
  const deadline = options.deadlineMs ?? INSIDER_PASS_DEADLINE_MS;
  const asOf = options.asOf ?? new Date();
  const from = new Date(asOf.getTime() - INSIDER_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const counters: InsiderPassCounters = { insiderCallsUsed: 0, insiderSucceeded: 0, insiderEmpty: 0, insiderFailed: 0, insiderSkippedByDeadline: 0, deadlineHit: false };
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
    if (counters.insiderCallsUsed > 0) await sleep(INSIDER_PACING_MS);
    counters.insiderCallsUsed++;

    let summary: InsiderSummary | null = null;
    const diag: InsiderTickerDiagnostics = { symbol: item.symbol, status: "failed", failureReason: null, rowsReturned: 0, rowsInWindow: 0, saleRowsCounted: 0, netSoldUsd: null, responseKeys: [] };
    try {
      const raw = await fetchRows(item.symbol, from);
      const result: InsiderFetchResult = Array.isArray(raw)
        ? { ok: true, rows: raw, responseKeys: [] }
        : raw == null
          ? { ok: false, reason: "fetch returned null", responseKeys: [] }
          : raw;
      diag.responseKeys = result.responseKeys;
      if (!result.ok) {
        diag.failureReason = result.reason;
      } else {
        const s = summarizeInsiderActivity(result.rows, asOf);
        diag.rowsReturned = s.rowsReturned;
        diag.rowsInWindow = s.rowsInWindow;
        diag.saleRowsCounted = s.insiderSaleCount30d;
        if (s.rowsReturned === 0) {
          // A valid but empty response: no data to report (n/a), not "$0 sold".
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
    if (diag.status === "ok") counters.insiderSucceeded++;
    else if (diag.status === "empty") counters.insiderEmpty++;
    else counters.insiderFailed++;
    summaries.set(item.symbol, summary);
    diagnostics.push(diag);

    try {
      await options.onResult?.(item, summary);
    } catch (err) {
      console.error(`[insider] persisting ${item.symbol} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return { ...counters, summaries, diagnostics };
}

export interface EnrichResult extends InsiderPassCounters {
  batchTag: string | null;
  rowsConsidered: number;
  error?: string;
}

/**
 * Second pass of the monthly scan: fills in insider fields on the latest
 * monthly batch's rows. Idempotent and resumable — only touches rows whose
 * insiderFetchedAt is null (retryFailed also re-attempts rows that were
 * attempted but came back with no data), so a partial run can be completed
 * without re-running the scan. insiderFetchedAt is set for every row
 * attempted, including failures, so "not attempted" stays distinguishable.
 * Never throws.
 */
export async function enrichInsiderForLatestMonthlyScan(
  options: InsiderPassOptions & { retryFailed?: boolean; /** Restrict to rows written by this scan run (the cron path); omitted = latest batch. */ sourceAgentRunId?: string } = {},
): Promise<EnrichResult> {
  const empty: EnrichResult = { batchTag: null, rowsConsidered: 0, insiderCallsUsed: 0, insiderSucceeded: 0, insiderEmpty: 0, insiderFailed: 0, insiderSkippedByDeadline: 0, deadlineHit: false };
  try {
    const latest = await prisma.candidateRecommendationLog.findFirst({
      where: { group: "GROUP_3", ...(options.sourceAgentRunId ? { sourceAgentRunId: options.sourceAgentRunId } : {}) },
      orderBy: { recommendedAt: "desc" },
      select: { batchTag: true },
    });
    if (!latest) return empty;

    const rows = await prisma.candidateRecommendationLog.findMany({
      where: {
        group: "GROUP_3",
        batchTag: latest.batchTag,
        ...(options.sourceAgentRunId ? { sourceAgentRunId: options.sourceAgentRunId } : {}),
        ...(options.retryFailed
          ? { OR: [{ insiderFetchedAt: null }, { insiderNetSoldUsd30d: null }] }
          : { insiderFetchedAt: null }),
      },
      orderBy: { rank: "asc" },
      select: { id: true, symbol: true },
    });

    const result = await runInsiderPass(rows, {
      ...options,
      onResult: async (item, summary) => {
        await prisma.candidateRecommendationLog.update({
          where: { id: item.id },
          data: {
            insiderFetchedAt: new Date(),
            ...(summary
              ? {
                  insiderNetSoldUsd30d: summary.insiderNetSoldUsd30d,
                  insiderSaleCount30d: summary.insiderSaleCount30d,
                  insiderSellers30d: summary.insiderSellers30d,
                  insiderHas10b5_1: summary.insiderHas10b5_1,
                }
              : {}),
          },
        });
      },
    });
    const { summaries: _s, diagnostics: _d, ...counters } = result;
    void _s;
    void _d;
    return { ...counters, batchTag: latest.batchTag, rowsConsidered: rows.length };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) };
  }
}
