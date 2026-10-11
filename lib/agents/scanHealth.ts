import { prisma } from "@/lib/prisma";
import type { ClaudeFailure } from "@/lib/agents/claudeFailures";

export type ScanHealthKind = "MONTHLY_SCAN" | "WEEKLY_SCAN" | "WEEKLY_BRIEF";
export type ScanHealthStatus = "HEALTHY" | "DEGRADED" | "FAILED";

export const MONTHLY_EXPECTED_ROWS = 30;
/** More than this share of rows missing extensionVs200d/vol60d => DEGRADED. */
export const MAX_NULL_FRAGILITY_SHARE = 0.2;
/** More than this share of attempted insider fetches returning zero rows => DEGRADED ("suspiciously empty": usually a parser/plan/coverage problem, not a quiet month). */
export const MAX_EMPTY_INSIDER_SHARE = 0.8;
/** More than this share of insider calls failing outright => DEGRADED. */
export const MAX_FAILED_INSIDER_SHARE = 0.5;
/** Fewer than this share of rows with insiderFetchedAt set => DEGRADED. */
export const MIN_INSIDER_ATTEMPTED_SHARE = 0.8;

export interface ScanHealthInput {
  kind: ScanHealthKind;
  /** Set when the run itself threw / ended FAILED; forces FAILED. */
  runFailed?: string | null;
  rowsLogged?: number;
  /** Null/undefined skips the "fewer rows than expected" check (e.g. weekly scans, whose candidate count legitimately varies). */
  expectedRows?: number | null;
  /** Rows with BOTH extensionVs200d and vol60d non-null. */
  fragilityPopulatedRows?: number;
  /** Rows with insiderFetchedAt set; only meaningful for the monthly scan. */
  insiderAttemptedRows?: number;
  insiderApplicable?: boolean;
  insiderDeadlineHit?: boolean;
  insiderCounters?: { insiderCallsUsed: number; insiderSucceeded: number; insiderEmpty?: number; insiderFailed: number; insiderSkippedByDeadline: number } | null;
  claudeFailures?: ClaudeFailure[];
  sentimentCoveredSymbols?: number | null;
  durationMs?: number | null;
  limitMs?: number | null;
}

export interface ScanHealthResult {
  kind: ScanHealthKind;
  status: ScanHealthStatus;
  reasons: string[];
  metrics: Record<string, unknown>;
}

const share = (n: number, d: number) => (d > 0 ? n / d : null);

export function classifyScanHealth(input: ScanHealthInput): ScanHealthResult {
  const reasons: string[] = [];
  let failed = false;

  if (input.runFailed) {
    failed = true;
    reasons.push(`Run failed: ${input.runFailed}`);
  }
  const rows = input.rowsLogged;
  if (rows !== undefined && rows === 0 && !input.runFailed) {
    failed = true;
    reasons.push("No rows were logged.");
  }
  if (rows !== undefined && rows > 0) {
    if (input.expectedRows != null && rows < input.expectedRows) {
      reasons.push(`Only ${rows} rows logged, expected ${input.expectedRows}.`);
    }
    if (input.fragilityPopulatedRows !== undefined) {
      const nullShare = 1 - input.fragilityPopulatedRows / rows;
      if (nullShare > MAX_NULL_FRAGILITY_SHARE) {
        reasons.push(`${(nullShare * 100).toFixed(0)}% of rows have null extensionVs200d/vol60d (limit ${MAX_NULL_FRAGILITY_SHARE * 100}%).`);
      }
    }
    if (input.insiderApplicable && input.insiderAttemptedRows !== undefined) {
      const attempted = input.insiderAttemptedRows / rows;
      if (attempted < MIN_INSIDER_ATTEMPTED_SHARE) {
        reasons.push(`Insider pass attempted ${input.insiderAttemptedRows}/${rows} rows (${(attempted * 100).toFixed(0)}%, minimum ${MIN_INSIDER_ATTEMPTED_SHARE * 100}%).`);
      }
    }
  }
  const c = input.insiderCounters;
  if (c && c.insiderCallsUsed > 0) {
    const empty = c.insiderEmpty ?? 0;
    if (empty / c.insiderCallsUsed > MAX_EMPTY_INSIDER_SHARE) {
      reasons.push(`Insider data suspiciously empty: ${empty} of ${c.insiderCallsUsed} fetches returned zero rows (limit ${MAX_EMPTY_INSIDER_SHARE * 100}%).`);
    }
    if (c.insiderFailed / c.insiderCallsUsed > MAX_FAILED_INSIDER_SHARE) {
      reasons.push(`Insider fetch failures: ${c.insiderFailed} of ${c.insiderCallsUsed} calls failed (rate limit, plan or parse error).`);
    }
  }
  if (input.insiderDeadlineHit) reasons.push("Insider pass hit its wall-clock deadline; remaining rows left unattempted.");
  for (const f of input.claudeFailures ?? []) reasons.push(`Claude call failed — ${f.source}: ${f.reason}`);

  const status: ScanHealthStatus = failed ? "FAILED" : reasons.length > 0 ? "DEGRADED" : "HEALTHY";
  return {
    kind: input.kind,
    status,
    reasons,
    metrics: {
      rowsLogged: rows ?? null,
      expectedRows: input.expectedRows ?? null,
      fragilityPopulatedShare: rows ? share(input.fragilityPopulatedRows ?? 0, rows) : null,
      insiderAttemptedShare: rows && input.insiderApplicable ? share(input.insiderAttemptedRows ?? 0, rows) : null,
      ...(input.insiderCounters ?? {}),
      sentimentCoveredSymbols: input.sentimentCoveredSymbols ?? null,
      claudeFailureCount: input.claudeFailures?.length ?? 0,
      durationMs: input.durationMs ?? null,
      limitMs: input.limitMs ?? null,
    },
  };
}

/** Emails a short alert via Resend — only on DEGRADED/FAILED and only if RESEND_API_KEY and ALERT_EMAIL are both set; otherwise silent. Never throws. */
export async function maybeSendHealthAlert(result: ScanHealthResult): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_EMAIL;
  if (!apiKey || !to || result.status === "HEALTHY") return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.ALERT_FROM_EMAIL || "onboarding@resend.dev",
        to: [to],
        subject: `[Cecil] ${result.kind} ${result.status}`,
        text: `${result.kind} finished ${result.status}.\n\n${result.reasons.map((r) => `- ${r}`).join("\n")}`,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Stores the verdict (and sends the optional alert). Never throws — health recording must not fail a run. */
export async function recordScanHealth(result: ScanHealthResult, agentRunId?: string | null): Promise<void> {
  try {
    await prisma.scanHealth.create({
      data: { kind: result.kind, status: result.status, reasons: result.reasons, metrics: result.metrics as object, agentRunId: agentRunId ?? null },
    });
  } catch (err) {
    console.error("recordScanHealth failed:", err instanceof Error ? err.message : err);
  }
  await maybeSendHealthAlert(result);
}

export interface LatestScanHealth {
  kind: ScanHealthKind;
  status: ScanHealthStatus;
  reasons: string[];
  metrics: Record<string, unknown>;
  createdAt: Date;
}

export async function getLatestScanHealth(): Promise<LatestScanHealth[]> {
  const kinds: ScanHealthKind[] = ["MONTHLY_SCAN", "WEEKLY_SCAN", "WEEKLY_BRIEF"];
  const rows = await Promise.all(kinds.map((kind) => prisma.scanHealth.findFirst({ where: { kind }, orderBy: { createdAt: "desc" } })));
  return rows
    .filter((r): r is NonNullable<typeof r> => r != null)
    .map((r) => ({
      kind: r.kind as ScanHealthKind,
      status: r.status,
      reasons: Array.isArray(r.reasons) ? (r.reasons as string[]) : [],
      metrics: (r.metrics ?? {}) as Record<string, unknown>,
      createdAt: r.createdAt,
    }));
}

/** Row-level metrics for a batch of log rows written by one run. */
export async function loadRunRowMetrics(agentRunId: string, group: "GROUP_1" | "GROUP_3") {
  const rows = await prisma.candidateRecommendationLog.findMany({
    where: { sourceAgentRunId: agentRunId, group },
    select: { extensionVs200d: true, vol60d: true, insiderFetchedAt: true },
  });
  return {
    rowsLogged: rows.length,
    fragilityPopulatedRows: rows.filter((r) => r.extensionVs200d != null && r.vol60d != null).length,
    insiderAttemptedRows: rows.filter((r) => r.insiderFetchedAt != null).length,
  };
}

export async function countSentimentCovered(): Promise<number | null> {
  try {
    return await prisma.sentimentFetchState.count({ where: { hasCoverage: true } });
  } catch {
    return null;
  }
}
