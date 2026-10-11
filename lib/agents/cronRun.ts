import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { recordScanHealth, type ScanHealthStatus } from "@/lib/agents/scanHealth";

/**
 * Every cron invocation leaves a trail in the app itself (ScanHealth, kind
 * "CRON:<name>") so a missed, skipped or silently failing run is visible
 * without Vercel's short-retention logs: a "start" row the moment the handler
 * is reached, and a "finish" row with ok / failed / skipped + the reason.
 * A skip is NEVER a 2xx: ok -> 200, skipped -> 422, failed -> 500.
 *
 * Unauthorized calls are deliberately not recorded (the cron paths bypass the
 * PIN gate, so recording them would let anyone write rows).
 */
export type CronName = "db-keepalive" | "earnings-estimates" | "news-sentiment" | "refresh-candidate-universe" | "weekly-brief";
export type CronOutcome = "ok" | "failed" | "skipped";

export interface CronHandlerResult {
  outcome: CronOutcome;
  /** Required context for failed/skipped; shown in the finish row. */
  reason?: string;
  /** JSON body returned to the caller. */
  body?: Record<string, unknown>;
  /** Extra non-fatal problems: an "ok" with reasons is recorded as DEGRADED. */
  warnings?: string[];
  metrics?: Record<string, unknown>;
}

export const CRON_KIND_PREFIX = "CRON:";

export function cronHttpStatus(outcome: CronOutcome): number {
  return outcome === "ok" ? 200 : outcome === "skipped" ? 422 : 500;
}

export function cronStatus(result: Pick<CronHandlerResult, "outcome" | "warnings">): ScanHealthStatus {
  if (result.outcome === "failed") return "FAILED";
  if (result.outcome === "skipped" || (result.warnings?.length ?? 0) > 0) return "DEGRADED";
  return "HEALTHY";
}

export function isDryRun(request: NextRequest): boolean {
  return request.nextUrl.searchParams.get("dryRun") === "1";
}

async function writeStartRow(kind: string, request: NextRequest): Promise<void> {
  try {
    await prisma.scanHealth.create({
      data: {
        kind,
        status: "HEALTHY",
        reasons: ["handler reached"],
        metrics: { phase: "start", userAgent: request.headers.get("user-agent") ?? null, dryRun: isDryRun(request), startedAt: new Date().toISOString() },
      },
    });
  } catch (err) {
    console.error(`[cron ${kind}] could not write start row:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Runs a cron handler with start/finish recording. The handler never needs to
 * catch: a throw becomes a recorded FAILED run and a 500. `handler` is only
 * reached after the route's own auth check.
 */
export async function runCron(name: CronName, request: NextRequest, handler: () => Promise<CronHandlerResult>): Promise<NextResponse> {
  const kind = `${CRON_KIND_PREFIX}${name}`;
  const startedAt = Date.now();
  await writeStartRow(kind, request);

  let result: CronHandlerResult;
  try {
    result = await handler();
  } catch (err) {
    result = { outcome: "failed", reason: err instanceof Error ? err.message : String(err) };
    console.error(`[cron ${name}] handler threw:`, err);
  }

  const reasons = [
    ...(result.outcome === "ok" ? [] : [result.reason ?? `${result.outcome} (no reason given)`]),
    ...(result.warnings ?? []),
  ];
  await recordScanHealth({
    kind: kind as never,
    status: cronStatus(result),
    reasons,
    metrics: { phase: "finish", outcome: result.outcome, durationMs: Date.now() - startedAt, dryRun: isDryRun(request), ...(result.metrics ?? {}) },
  });

  const status = cronHttpStatus(result.outcome);
  const body = { outcome: result.outcome, ...(result.reason ? { reason: result.reason } : {}), ...(result.warnings?.length ? { warnings: result.warnings } : {}), ...(result.body ?? {}) };
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export interface CronRunSummary {
  kind: string;
  status: ScanHealthStatus;
  reasons: string[];
  phase: string | null;
  outcome: string | null;
  createdAt: Date;
}

/** Most recent start/finish rows across all cron kinds (newest first) — for the Agents page and /api/agents/scan-health. */
export async function getRecentCronRuns(limit = 20): Promise<CronRunSummary[]> {
  const rows = await prisma.scanHealth.findMany({
    where: { kind: { startsWith: CRON_KIND_PREFIX } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map((r) => {
    const m = (r.metrics ?? {}) as Record<string, unknown>;
    return {
      kind: r.kind,
      status: r.status,
      reasons: Array.isArray(r.reasons) ? (r.reasons as string[]) : [],
      phase: typeof m.phase === "string" ? m.phase : null,
      outcome: typeof m.outcome === "string" ? m.outcome : null,
      createdAt: r.createdAt,
    };
  });
}

export interface CronLatest {
  name: string;
  /** "ok" | "failed" | "skipped", or "started-no-finish" when the newest row is a start with no finish after it (the run died or is still going). */
  state: string;
  reasons: string[];
  at: Date;
}

/** Newest state per cron from newest-first rows. */
export function summarizeCronRuns(rows: CronRunSummary[]): CronLatest[] {
  const seen = new Set<string>();
  const out: CronLatest[] = [];
  for (const r of rows) {
    if (seen.has(r.kind)) continue;
    seen.add(r.kind);
    out.push({
      name: r.kind.slice(CRON_KIND_PREFIX.length),
      state: r.phase === "start" ? "started-no-finish" : (r.outcome ?? "unknown"),
      reasons: r.phase === "start" ? [] : r.reasons,
      at: r.createdAt,
    });
  }
  return out;
}
