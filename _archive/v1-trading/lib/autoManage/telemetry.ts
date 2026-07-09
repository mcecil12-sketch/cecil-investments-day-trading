import { redis } from "@/lib/redis";

export type AutoManageOutcome = "SUCCESS" | "SKIP" | "FAIL";

export type AutoManageRun = {
  ts: string;
  outcome: AutoManageOutcome;
  reason?: string;
  checked?: number;
  updated?: number;
  flattened?: number;
  eodFlattenAttempted?: number;
  eodFlattenSucceeded?: number;
  eodFlattenFailed?: number;
  flattenOrderCount?: number;
  flattenClosedCount?: number;
  staleOpenPositionsCount?: number;
  staleOpenTradesCount?: number;
  lastFlattenAt?: string;
  lastFlattenOutcome?: string;
  flattenFailures?: number;
  replacementConsidered?: boolean;
  replacementExecuted?: boolean;
  replacementReason?: string;
  rescueAttempted?: number;
  rescueOk?: number;
  rescueFailed?: number;
  source?: string;
  runId?: string;
};

const KEY_SUMMARY = "telemetry:auto-manage:summary";
const KEY_RUNS = "telemetry:auto-manage:runs";
const KEY_STOP_RESCUE = "telemetry:auto-manage:stop-rescue";

const hasRedis = () => !!redis;

export async function recordAutoManage(run: AutoManageRun) {
  if (!hasRedis()) return;

  const ts = run.ts || new Date().toISOString();
  const outcome = run.outcome;

  const incr: Record<string, number> = { runs: 1 };
  if (outcome === "SUCCESS") incr.success = 1;
  if (outcome === "FAIL") incr.fail = 1;
  if (outcome === "SKIP") incr.skipped = 1;
  if (run.eodFlattenAttempted) incr.eodFlattenAttempted = run.eodFlattenAttempted;
  if (run.eodFlattenSucceeded) incr.eodFlattenSucceeded = run.eodFlattenSucceeded;
  if (run.eodFlattenFailed) incr.eodFlattenFailed = run.eodFlattenFailed;
  if (run.flattenOrderCount) incr.flattenOrderCount = run.flattenOrderCount;
  if (run.flattenClosedCount) incr.flattenClosedCount = run.flattenClosedCount;
  if (run.flattenFailures) incr.flattenFailures = run.flattenFailures;
  if (run.staleOpenPositionsCount) incr.staleOpenPositionsCount = run.staleOpenPositionsCount;
  if (run.staleOpenTradesCount) incr.staleOpenTradesCount = run.staleOpenTradesCount;
  if (run.rescueAttempted) incr.rescueAttempted = run.rescueAttempted;
  if (run.rescueOk) incr.rescueOk = run.rescueOk;
  if (run.rescueFailed) incr.rescueFailed = run.rescueFailed;

  const reasonKey = run.reason ? `reason:${run.reason}` : undefined;

  try {
    const pipe = redis!.multi();
    for (const [k, v] of Object.entries(incr)) pipe.hincrby(KEY_SUMMARY, k, v);
    if (reasonKey) pipe.hincrby(KEY_SUMMARY, reasonKey, 1);

    pipe.hset(KEY_SUMMARY, {
      lastRunAt: ts,
      lastOutcome: outcome,
      lastReason: run.reason || "",
      lastSource: run.source || "",
      lastRunId: run.runId || "",
      lastFlattenAt: run.lastFlattenAt || "",
      lastFlattenOutcome: run.lastFlattenOutcome || "",
      lastFlattenFailures: run.flattenFailures || 0,
      lastStaleOpenPositionsCount: run.staleOpenPositionsCount || 0,
      lastStaleOpenTradesCount: run.staleOpenTradesCount || 0,
      lastReplacementConsidered: run.replacementConsidered ? 1 : 0,
      lastReplacementExecuted: run.replacementExecuted ? 1 : 0,
      lastReplacementReason: run.replacementReason || "",
      lastRescueAttempted: run.rescueAttempted || 0,
      lastRescueOk: run.rescueOk || 0,
      lastRescueFailed: run.rescueFailed || 0,
    });

    pipe.lpush(KEY_RUNS, JSON.stringify({ ...run, ts }));
    pipe.ltrim(KEY_RUNS, 0, 199);

    await pipe.exec();
  } catch {}
}

export async function readAutoManageTelemetry(limit = 50) {
  if (!hasRedis()) {
    return {
      ok: true,
      summary: { runs: 0, success: 0, fail: 0, skipped: 0 },
      runs: [],
      redis: false,
    };
  }

  try {
    const [summary, runs] = await Promise.all([
      redis!.hgetall(KEY_SUMMARY),
      redis!.lrange(KEY_RUNS, 0, Math.max(0, limit - 1)),
    ]);

    const parsedRuns = (runs || [])
      .map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    return { ok: true, summary: summary || {}, runs: parsedRuns, redis: true };
  } catch {
    return {
      ok: true,
      summary: { runs: 0, success: 0, fail: 0, skipped: 0 },
      runs: [],
      redis: true,
      degraded: true,
    };
  }
}
