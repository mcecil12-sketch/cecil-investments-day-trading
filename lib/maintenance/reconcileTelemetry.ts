import { redis } from "@/lib/redis";

export type ReconcileRun = {
  ts: string;
  source?: string;
  runId?: string;
  checked?: number;
  closed?: number;
  synced?: number;
  ok?: boolean;
};

const KEY_SUMMARY = "telemetry:reconcile:summary";
const KEY_RUNS = "telemetry:reconcile:runs";

const hasRedis = () => !!redis;

export async function recordReconcile(run: ReconcileRun) {
  if (!hasRedis()) return;

  const ts = run.ts || new Date().toISOString();
  const ok = run.ok !== false;

  const incr: Record<string, number> = { runs: 1 };
  if (ok) incr.success = 1;
  if (!ok) incr.fail = 1;

  try {
    const pipe = redis!.multi();
    for (const [k, v] of Object.entries(incr)) pipe.hincrby(KEY_SUMMARY, k, v);

    if (Number.isFinite(run.closed)) {
      pipe.hincrby(KEY_SUMMARY, "totalClosed", run.closed || 0);
    }
    if (Number.isFinite(run.synced)) {
      pipe.hincrby(KEY_SUMMARY, "totalSynced", run.synced || 0);
    }

    pipe.hset(KEY_SUMMARY, {
      lastRunAt: ts,
      lastOk: ok ? "true" : "false",
      lastSource: run.source || "",
      lastRunId: run.runId || "",
      lastClosed: String(run.closed || 0),
      lastSynced: String(run.synced || 0),
      lastChecked: String(run.checked || 0),
    });

    pipe.lpush(KEY_RUNS, JSON.stringify({ ...run, ts }));
    pipe.ltrim(KEY_RUNS, 0, 99);

    await pipe.exec();
  } catch (e) {
    console.warn("[reconcile-telemetry] failed to record:", e);
  }
}

export async function readReconcileTelemetry(limit = 50) {
  if (!hasRedis()) {
    return {
      ok: true,
      summary: { runs: 0, success: 0, fail: 0 },
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
  } catch (e) {
    console.warn("[reconcile-telemetry] failed to read:", e);
    return {
      ok: true,
      summary: { runs: 0, success: 0, fail: 0 },
      runs: [],
      redis: true,
      degraded: true,
    };
  }
}
