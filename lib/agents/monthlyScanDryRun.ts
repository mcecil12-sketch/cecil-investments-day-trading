import { runMonthlyScanAgent, MAX_TRACKED_CANDIDATES, type MonthlyScanDiagnostics } from "@/lib/agents/monthlyScan";
import { runInsiderPass, INSIDER_PASS_DEADLINE_MS, type InsiderPassOptions, type InsiderTickerDiagnostics } from "@/lib/agents/insiderEnrichment";

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
  insider: { insiderCallsUsed: number; insiderSucceeded: number; insiderEmpty: number; insiderFailed: number; insiderSkippedByDeadline: number; deadlineHit: boolean };
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
  }>;
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
  insiderOptions: Pick<InsiderPassOptions, "fetchRows" | "sleep" | "now" | "deadlineMs"> = {},
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
      insiderFailed: pass.insiderFailed,
      insiderSkippedByDeadline: pass.insiderSkippedByDeadline,
      deadlineHit: pass.deadlineHit,
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
    })),
    notes: [
      "Nothing was written: no log rows, no AgentRun, no earnings/sentiment/S&P cache updates.",
      "S&P series read from the existing cache without refreshing it.",
    ],
  };
}
