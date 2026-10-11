import type { OverviewResult } from "@/lib/agents/marketCap";
import { runMonthlyScanAgent, MAX_TRACKED_CANDIDATES, type MonthlyScanDiagnostics } from "@/lib/agents/monthlyScan";
import { runInsiderPass, runMarketCapPass, INSIDER_PASS_DEADLINE_MS, type InsiderPassOptions, type InsiderTickerDiagnostics } from "@/lib/agents/insiderEnrichment";

export const MONTHLY_ROUTE_MAX_DURATION_MS = 240_000;

export interface MonthlyScanDryRunReport {
  /** Never "cron" — a dry run can never count toward the trading-readiness banner, and nothing about it is persisted. */
  triggerSource: "dry_run";
  wroteNothing: true;
  phaseMs: Record<string, number>;
  totalMs: number;
  maxDurationMs: number;
  percentOfMaxDuration: number;
  counts: { universeSymbols: number; scored: number; skipped: number; ranked: number; wouldWriteRows: number };
  insider: { insiderCallsUsed: number; insiderSucceeded: number; insiderEmpty: number; insiderNoFilings: number; insiderFailed: number; insiderSkippedByDeadline: number; deadlineHit: boolean; insiderRequests: number; insiderFromEdgar: number; insiderFromAlphaVantage: number; elapsedMs: number; /** True when every ranked name was fetched inside INSIDER_PASS_DEADLINE_MS — if false, enrichment needs more than one pass (resume with the enrich-insider route). */ fitsTimeBudget: boolean };
  fragilityFlagCount: number;
  /** One entry per ranked ticker: what the insider call actually returned and how it was counted. */
  insiderByTicker: InsiderTickerDiagnostics[];
  top10: Array<{
    rank: number;
    symbol: string;
    composite: number;
    extensionVs200d: number | null;
    vol60d: number | null;
    fragilityPercentile: number | null;
    fragilityFlag: boolean | null;
    insiderNetSoldUsd30d: number | null;
    /** "no_filings" = EDGAR valid result with no sales/purchases in the window ($0, not n/a). */
    insiderStatus: "ok" | "no_filings" | "empty" | "failed" | null;
    marketCap: number | null;
    /** Net sold as a percent of market cap (positive = net selling). */
    insiderNetSoldPctOfMarketCap: number | null;
  }>;
  marketCapPass: { attempted: number; ok: number; failed: number; skippedByDeadline: number };
  notes: string[];
}

/**
 * Runs the whole monthly pipeline — price fetches, fragility metrics, and the
 * insider pass at its real pacing — but persists NOTHING: no
 * CandidateRecommendationLog rows, no AgentRun, no earnings/sentiment/S&P
 * cache writes (see the dryRun option on runMonthlyScanAgent). The insider
 * summaries are kept in memory only, to fill the report.
 */
export async function runMonthlyScanDryRun(
  insiderOptions: Pick<InsiderPassOptions, "fetchRows" | "sleep" | "now" | "deadlineMs"> & { fetchOverviewFn?: (symbol: string) => Promise<OverviewResult> } = {},
): Promise<MonthlyScanDryRunReport> {
  const startedAtMs = (insiderOptions.now ?? Date.now)();
  const diagnostics: MonthlyScanDiagnostics = { phaseMs: {}, universeSymbols: 0 };
  const output = await runMonthlyScanAgent("manual", { dryRun: true, diagnostics });

  const insiderStart = Date.now();
  const pass = await runInsiderPass(
    output.rankedCandidates.map((c) => ({ id: c.symbol, symbol: c.symbol })),
    { ...insiderOptions, startedAtMs, deadlineMs: insiderOptions.deadlineMs ?? INSIDER_PASS_DEADLINE_MS },
  );
  diagnostics.phaseMs.insiderPass = Date.now() - insiderStart;

  const capStart = Date.now();
  const cap = await runMarketCapPass(
    output.rankedCandidates.map((c) => ({ id: c.symbol, symbol: c.symbol, scanClose: c.lastClose, insiderNetSoldUsd30d: pass.summaries.get(c.symbol)?.insiderNetSoldUsd30d ?? null })),
    { startedAtMs, deadlineMs: insiderOptions.deadlineMs ?? INSIDER_PASS_DEADLINE_MS, sleep: insiderOptions.sleep, now: insiderOptions.now, fetchOverviewFn: insiderOptions.fetchOverviewFn },
  );
  diagnostics.phaseMs.marketCapPass = Date.now() - capStart;

  const totalMs = Date.now() - startedAtMs;
  const ranked = output.rankedCandidates;
  return {
    triggerSource: "dry_run",
    wroteNothing: true,
    phaseMs: diagnostics.phaseMs,
    totalMs,
    maxDurationMs: MONTHLY_ROUTE_MAX_DURATION_MS,
    percentOfMaxDuration: Math.round((totalMs / MONTHLY_ROUTE_MAX_DURATION_MS) * 1000) / 10,
    counts: {
      universeSymbols: diagnostics.universeSymbols,
      scored: ranked.length,
      skipped: output.skipped.length,
      ranked: ranked.length,
      wouldWriteRows: Math.min(ranked.length, MAX_TRACKED_CANDIDATES),
    },
    insider: {
      insiderCallsUsed: pass.insiderCallsUsed,
      insiderSucceeded: pass.insiderSucceeded,
      insiderEmpty: pass.insiderEmpty,
      insiderNoFilings: pass.insiderNoFilings,
      insiderFailed: pass.insiderFailed,
      insiderSkippedByDeadline: pass.insiderSkippedByDeadline,
      deadlineHit: pass.deadlineHit,
      insiderRequests: pass.insiderRequests,
      insiderFromEdgar: pass.insiderFromEdgar,
      insiderFromAlphaVantage: pass.insiderFromAlphaVantage,
      elapsedMs: pass.elapsedMs,
      fitsTimeBudget: !pass.deadlineHit && pass.insiderSkippedByDeadline === 0,
    },
    fragilityFlagCount: ranked.filter((c) => c.fragilityFlag === true).length,
    insiderByTicker: pass.diagnostics,
    top10: ranked.slice(0, 10).map((c) => ({
      rank: c.rank,
      symbol: c.symbol,
      composite: c.score,
      extensionVs200d: c.extensionVs200d,
      vol60d: c.vol60d,
      fragilityPercentile: c.fragilityPercentile,
      fragilityFlag: c.fragilityFlag,
      insiderNetSoldUsd30d: pass.summaries.get(c.symbol)?.insiderNetSoldUsd30d ?? null,
      insiderStatus: pass.diagnostics.find((d) => d.symbol === c.symbol)?.status ?? null,
      marketCap: cap.results.get(c.symbol)?.marketCap ?? null,
      insiderNetSoldPctOfMarketCap: cap.results.get(c.symbol)?.pct ?? null,
    })),
    marketCapPass: { attempted: cap.marketCapAttempted, ok: cap.marketCapOk, failed: cap.marketCapFailed, skippedByDeadline: cap.marketCapSkippedByDeadline },
    notes: [
      "Nothing was written: no log rows, no AgentRun, no earnings/sentiment/S&P cache updates.",
      "S&P series read from the existing cache without refreshing it.",
    ],
  };
}
