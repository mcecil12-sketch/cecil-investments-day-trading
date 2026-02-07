import { NextResponse } from "next/server";
import { readSignals, writeSignals } from "@/lib/jsonDb";
import { redis } from "@/lib/redis";
import { bumpTodayFunnel } from "@/lib/funnelRedis";
import { scoreSignalWithAI } from "@/lib/aiScoring";
import { touchHeartbeat } from "@/lib/aiHeartbeat";
import {
  applyParseFailed,
  applyScoreError,
  applyScoreSuccess,
} from "@/lib/ai/scoreDrainApply";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120; // Allow up to 120s runtime on Vercel/Next.js

// Execution guards: wall-clock timeout and max signals per run
// DEADLINE_MS is the internal time budget; we soft-stop at ~8s before this to avoid hard timeout
const DEADLINE_MS = Number(process.env.AI_SCORE_DRAIN_DEADLINE_MS ?? 110000); // 110s internal budget
const SOFT_STOP_MARGIN_MS = 8000; // Stop starting new work when <8s remaining
const MAX_PER_RUN = Number(process.env.AI_SCORE_DRAIN_MAX ?? 25);
const SCORING_CONCURRENCY = Number(process.env.AI_SCORE_DRAIN_CONCURRENCY ?? 5); // Parallel scoring workers

const DRAIN_LOCK_KEY = "ai:score:drain:lock";
const DRAIN_LOCK_TTL = 30; // seconds

/**
 * Check cron token authorization (fast, synchronous)
 */
function checkCronAuth(req: Request): { ok: boolean; reason?: string } {
  const token = req.headers.get("x-cron-token") || "";
  if (!process.env.CRON_TOKEN || token !== process.env.CRON_TOKEN) {
    return { ok: false, reason: "unauthorized" };
  }
  return { ok: true };
}

/**
 * Try to acquire Redis lock with deadline-based TTL
 */
async function acquireDrainLock(deadlineAtMs: number): Promise<boolean> {
  if (!redis) return true; // Local mode: allow without lock
  try {
    const ttlMs = Math.max(100, deadlineAtMs - Date.now());
    const ttlSec = Math.ceil(ttlMs / 1000);
    const ok = await redis.set(DRAIN_LOCK_KEY, "1", {
      nx: true,
      ex: Math.min(ttlSec, DRAIN_LOCK_TTL),
    });
    return Boolean(ok);
  } catch (err) {
    console.error("[score/drain] lock acquire error", err);
    return false;
  }
}

/**
 * Release the drain lock (non-fatal if fails)
 */
async function releaseDrainLock(): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(DRAIN_LOCK_KEY);
  } catch (err) {
    console.warn("[score/drain] lock release error", err);
  }
}

/**
 * Score a signal with deadline enforcement (Promise.race with timeout)
 */
async function scoreWithTimeout(
  signal: any,
  deadlineAtMs: number
): Promise<
  | { ok: true; scored: any; meta?: { aiModel?: string | null; aiRequestId?: string | null } }
  | {
      ok: false;
      error: string;
      reason: string;
      meta?: {
        aiModel?: string | null;
        aiRawHead?: string | null;
        aiParseError?: string | null;
        aiRequestId?: string | null;
      };
    }
> {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    return { ok: false, error: "timeout", reason: "deadline_exceeded" };
  }

  try {
    // Race the scoring against the deadline
    const result = await Promise.race([
      scoreSignalWithAI({
        id: signal.id,
        ticker: signal.ticker,
        side: signal.side,
        entryPrice: signal.entryPrice,
        stopPrice: signal.stopPrice || 0,
        targetPrice: signal.targetPrice || 0,
        timeframe: signal.timeframe || "1Min",
        source: signal.source || "DRAIN",
        createdAt: signal.createdAt,
        reasoning: signal.reasoning,
      }),
      new Promise<{ ok: false; error: string; reason: string }>((_, reject) =>
        setTimeout(
          () => reject(new Error("scoring_timeout")),
          remainingMs - 500 // Leave 500ms buffer
        )
      ),
    ]);

    if (result.ok) {
      return {
        ok: true,
        scored: result.scored,
        meta: { aiModel: result.aiModel, aiRequestId: result.aiRequestId },
      };
    }

    const isParseFailed =
      result.error === "ai_parse_failed" || result.error === "invalid_model_output";
    const hasAiMeta = typeof result === "object" && result != null && "aiModel" in result;
    const aiModel = hasAiMeta ? (result as any).aiModel : null;
    const aiRawHead = hasAiMeta ? (result as any).rawHead : null;
    const aiParseError = hasAiMeta ? (result as any).aiParseError : null;
    const aiRequestId = hasAiMeta ? (result as any).aiRequestId : null;
    return {
      ok: false,
      error: isParseFailed ? "parse_failed" : result.error,
      reason: result.reason,
      meta: {
        aiModel,
        aiRawHead,
        aiParseError: aiParseError ?? result.reason,
        aiRequestId,
      },
    };
  } catch (err) {
    const errStr = String(err);
    if (errStr.includes("timeout")) {
      return { ok: false, error: "timeout", reason: "deadline_exceeded" };
    }
    return {
      ok: false,
      error: "scoring_failed",
      reason: errStr,
    };
  }
}

/**
 * Process signals with concurrent scoring pool
 * Returns: { scoredCount, errorCount, timeoutCount, details }
 */
async function scoreSignalsConcurrent(
  signals: any[],
  deadlineAtMs: number,
  concurrency: number
): Promise<{
  scoredCount: number;
  errorCount: number;
  timeoutCount: number;
  details: Array<{
    id: string;
    ticker: string;
    status: "SCORED" | "ERROR";
    aiScore?: number | null;
    error?: string;
  }>;
  results: Array<{
    signal: any;
    status: "SCORED" | "ERROR" | "TIMEOUT";
    scoreResult?: any;
    errorReason?: string;
    errorCode?: string;
    errorMeta?: {
      aiModel?: string | null;
      aiRawHead?: string | null;
      aiParseError?: string | null;
      aiRequestId?: string | null;
    };
  }>;
}> {
  const results: Array<{
    signal: any;
    status: "SCORED" | "ERROR" | "TIMEOUT";
    scoreResult?: any;
    errorReason?: string;
    errorCode?: string;
    errorMeta?: {
      aiModel?: string | null;
      aiRawHead?: string | null;
      aiParseError?: string | null;
      aiRequestId?: string | null;
    };
  }> = [];
  const details: Array<{
    id: string;
    ticker: string;
    status: "SCORED" | "ERROR";
    aiScore?: number | null;
    error?: string;
  }> = [];

  let scoredCount = 0;
  let errorCount = 0;
  let timeoutCount = 0;

  // Process with concurrency limit
  let i = 0;
  while (i < signals.length) {
    // Check soft stop margin: if <8s remaining, stop starting new work
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs < SOFT_STOP_MARGIN_MS) {
      console.log("[score/drain] soft stop margin reached", {
        remainingMs,
        margin: SOFT_STOP_MARGIN_MS,
        processed: i,
        total: signals.length,
      });
      break;
    }

    // Launch up to `concurrency` tasks
    const batch = signals.slice(i, i + concurrency);
    const promises = batch.map((signal) => scoreWithTimeout(signal, deadlineAtMs));

    const batchResults = await Promise.allSettled(promises);

    for (let j = 0; j < batch.length; ++j) {
      const signal = batch[j];
      const settledResult = batchResults[j];

      if (settledResult.status === "rejected") {
        // Promise.allSettled rejected (shouldn't happen, but handle it)
        results.push({
          signal,
          status: "ERROR",
          errorReason: String(settledResult.reason),
          errorCode: "promise_rejected",
        });
        errorCount += 1;
        details.push({
          id: signal.id,
          ticker: signal.ticker,
          status: "ERROR",
          error: "promise_rejected",
        });
        continue;
      }

      const scoreResult = settledResult.value;

      if (!scoreResult.ok) {
        if (scoreResult.reason === "deadline_exceeded") {
          results.push({
            signal,
            status: "TIMEOUT",
            errorReason: scoreResult.reason,
          });
          timeoutCount += 1;
        } else {
          results.push({
            signal,
            status: "ERROR",
            scoreResult,
            errorReason: scoreResult.reason,
            errorCode: scoreResult.error,
            errorMeta: scoreResult.meta,
          });
          errorCount += 1;
          details.push({
            id: signal.id,
            ticker: signal.ticker,
            status: "ERROR",
            error: scoreResult.error,
          });
        }
        continue;
      }

      // Success
      results.push({
        signal,
        status: "SCORED",
        scoreResult: scoreResult.scored,
      });
      scoredCount += 1;
      details.push({
        id: signal.id,
        ticker: signal.ticker,
        status: "SCORED",
        aiScore: scoreResult.scored.aiScore,
      });
    }

    i += batch.length;
  }

  // Cap details to 20 entries for response size
  const cappedDetails = details.slice(0, 20);

  return {
    scoredCount,
    errorCount,
    timeoutCount,
    details: cappedDetails,
    results,
  };
}

/**
 * Build response JSON (always JSON, never throw)
 */
function buildResponse(
  result: any,
  startedAtMs: number,
  statusCode: number
): NextResponse {
  result.durationMs = Date.now() - startedAtMs;
  return NextResponse.json(result, {
    status: statusCode,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * POST /api/ai/score/drain?limit=25
 *
 * Drain PENDING signals with strict guarantees:
 * - Hard wall-clock timeout (default 8s)
 * - Max signals per run (default 25)
 * - Redis lock always released
 * - Always returns JSON
 * - Allows partial progress
 * - Never leaves signals PENDING due to timeout
 */
export async function POST(req: Request) {
  const startedAtMs = Date.now();
  const deadlineAtMs = startedAtMs + DEADLINE_MS;

  // Helper: check if deadline expired
  function isExpired(): boolean {
    return Date.now() >= deadlineAtMs;
  }

  // Check authorization (fast)
  const auth = checkCronAuth(req);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: "unauthorized", reason: auth.reason },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  // Initialize result object (guaranteed to be returned as JSON)
  const result: {
    ok: boolean;
    processed: number;
    scored: number;
    errored: number;
    skipped: boolean;
    reason?: string;
    expired: boolean;
    durationMs: number;
    remainingTimeMs?: number;
    releasedCount: number;
    reclaimedCount: number;
    attemptedCount: number;
    completedCount: number;
    scoredCount: number;
    errorCount: number;
    timeoutCount: number;
    details: Array<{
      id: string;
      ticker: string;
      status: "SCORED" | "ERROR";
      aiScore?: number | null;
      error?: string;
    }>;
    pickedStrategy?: "recent_first" | "backlog_fallback" | "backlog_oldest_first";
    recentWindowHours?: number;
    newestPickedCreatedAt?: string | null;
    oldestPickedCreatedAt?: string | null;
  } = {
    ok: true,
    processed: 0,
    scored: 0,
    errored: 0,
    skipped: false,
    reason: undefined,
    expired: false,
    durationMs: 0,
    remainingTimeMs: 0,
    releasedCount: 0,
    reclaimedCount: 0,
    attemptedCount: 0,
    completedCount: 0,
    scoredCount: 0,
    errorCount: 0,
    timeoutCount: 0,
    details: [],
  };


  let lockAcquired = false;

  try {
    // Try to acquire Redis lock (fail fast if already locked)
    lockAcquired = await acquireDrainLock(deadlineAtMs);
    if (!lockAcquired) {
      result.skipped = true;
      result.reason = "already_running";
      console.log("[score/drain] skipped: already running");
      return buildResponse(result, startedAtMs, 200);
    }

    // If authorization passed and lock acquired, proceed
    // --- AI scoring drain: always prioritize newest PENDING signals for real-time funnel health ---
    // Why newest-first? Ensures the most recent signals are scored promptly, keeping the funnel responsive and preventing backlog starvation.
    const signals = await readSignals();
    const now = new Date();
    const RECENT_WINDOW_HOURS = Number(process.env.AI_SCORE_DRAIN_RECENT_HOURS ?? 6);
    const recentWindowStart = new Date(now.getTime() - RECENT_WINDOW_HOURS * 60 * 60 * 1000);

    // === RECLAIM STALE SCORING SIGNALS ===
    // Before picking new signals, find any stuck SCORING signals older than 10 minutes and revert them to PENDING
    const SCORING_STALE_MINUTES = 10;
    const scoringStaleThreshold = new Date(now.getTime() - SCORING_STALE_MINUTES * 60 * 1000);
    const staleScoring = signals.filter(
      (s) => s.status === "SCORING" && new Date(s.scoringStartedAt || s.createdAt) < scoringStaleThreshold
    );

    for (const s of staleScoring.slice(0, 200)) {
      // Limit reclaim batch to 200 per run
      s.status = "PENDING";
      s.scoringLockUntil = undefined;
      s.scoringStartedAt = undefined;
      s.updatedAt = new Date().toISOString();
      result.reclaimedCount += 1;
    }

    if (result.reclaimedCount > 0) {
      await writeSignals(signals);
      console.log("[score/drain] reclaimed stale SCORING signals", {
        reclaimedCount: result.reclaimedCount,
      });
    }

    // === TRACK CLAIMED AND FINALIZED SIGNAL IDs ===
    const claimedIds: string[] = [];
    const finalizedIds: string[] = [];

    // Parse backlog flag + strategy from query params
    const url = new URL(req.url);
    const qp = url.searchParams;
    const backlog = ["1", "true", "yes", "y", "on"].includes(
      (qp.get("backlog") || "").toLowerCase()
    );
    const strategyParam = (qp.get("strategy") || "").toLowerCase();
    const wantBacklogStrategy =
      backlog ||
      strategyParam === "backlog" ||
      strategyParam === "backlog_oldest_first";
    const releaseLimit = Number(qp.get("releaseLimit") ?? "-1"); // -1 = release all
    const limitParamRaw = Number(qp.get("limit") ?? "NaN");
    const limitParam = Number.isFinite(limitParamRaw) && limitParamRaw > 0 ? limitParamRaw : MAX_PER_RUN;
    const maxPerRun = Math.min(MAX_PER_RUN, limitParam);

    type PickStrategy = "recent_first" | "backlog_fallback" | "backlog_oldest_first";

    // Decide strategy (default stays recent_first)
    const pickedStrategy: PickStrategy = wantBacklogStrategy
      ? "backlog_oldest_first"
      : "recent_first";
    let pickedSignals: any[] = [];

    // Soft-stop guard: if low on time, don't attempt new work
    const remainingBeforePickMs = deadlineAtMs - Date.now();
    if (remainingBeforePickMs < SOFT_STOP_MARGIN_MS) {
      result.expired = true;
      result.reason = "deadline_soft_stop";
      result.remainingTimeMs = Math.max(0, remainingBeforePickMs);
      console.log("[score/drain] soft stop before picking", {
        remainingBeforePickMs,
        margin: SOFT_STOP_MARGIN_MS,
      });
      return buildResponse(result, startedAtMs, 200);
    }

    if (pickedStrategy === "backlog_oldest_first") {
      // Backlog mode: pick oldest-first (no recent window filter)
      pickedSignals = signals
        .filter((s) => s.status === "PENDING")
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        .slice(0, maxPerRun);
    } else {
      // Recent-first: pick newest within recent window
      pickedSignals = signals
        .filter((s) => s.status === "PENDING" && new Date(s.createdAt) >= recentWindowStart)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, maxPerRun);

      // Fallback: if none in recent window, pick newest PENDING from full backlog
      if (pickedSignals.length === 0) {
        pickedSignals = signals
          .filter((s) => s.status === "PENDING")
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, maxPerRun);
      }
    }

    // Claim/lock: mark as SCORING with a short TTL (2 min), revert to PENDING if not processed
    const claimUntil = new Date(Date.now() + 2 * 60 * 1000).toISOString();
    for (const s of pickedSignals) {
      s.status = "SCORING";
      s.scoringLockUntil = claimUntil;
      s.scoringStartedAt = new Date().toISOString();
      s.updatedAt = new Date().toISOString();
      claimedIds.push(s.id);
    }
    await writeSignals(signals);

    // For response visibility: compute createdAt range based on picked signals
    const recentWindowHours = RECENT_WINDOW_HOURS;
    const newestPickedCreatedAt = pickedSignals.length > 0
      ? pickedSignals.reduce((max, s) => (new Date(s.createdAt) > new Date(max) ? s.createdAt : max), pickedSignals[0].createdAt)
      : null;
    const oldestPickedCreatedAt = pickedSignals.length > 0
      ? pickedSignals.reduce((min, s) => (new Date(s.createdAt) < new Date(min) ? s.createdAt : min), pickedSignals[0].createdAt)
      : null;

    console.log("[score/drain] start", {
      pickedStrategy,
      pickedCount: pickedSignals.length,
      maxPerRun,
      deadlineMs: DEADLINE_MS,
      softStopMarginMs: SOFT_STOP_MARGIN_MS,
      concurrency: SCORING_CONCURRENCY,
      recentWindowHours,
      newestPickedCreatedAt,
      oldestPickedCreatedAt,
    });

    // Process signals with concurrency
    const concurrentResult = await scoreSignalsConcurrent(
      pickedSignals,
      deadlineAtMs,
      SCORING_CONCURRENCY
    );

    // Check if we hit soft stop
    if (concurrentResult.timeoutCount > 0 || (deadlineAtMs - Date.now() < SOFT_STOP_MARGIN_MS)) {
      result.expired = true;
    }

    // Apply scoring results to signals and track finalized IDs
    for (const procResult of concurrentResult.results) {
      const signal = procResult.signal;
      result.attemptedCount += 1;

      if (procResult.status === "TIMEOUT") {
        // Leave as SCORING; will be reclaimed on next run if not finished
        console.log("[score/drain] timeout", {
          id: signal.id,
          ticker: signal.ticker,
        });
        continue;
      }

      result.completedCount += 1;

      if (procResult.status === "ERROR") {
        const nowIso = new Date().toISOString();
        if (procResult.errorCode === "parse_failed") {
          applyParseFailed(
            signal,
            procResult.errorReason || "unparseable",
            procResult.errorMeta,
            nowIso
          );
        } else {
          applyScoreError(signal, procResult.errorReason, nowIso);
        }

        finalizedIds.push(signal.id);
        result.errored += 1;
        result.errorCount += 1;
        console.warn("[score/drain] score error", {
          id: signal.id,
          ticker: signal.ticker,
          reason: procResult.errorReason,
          code: procResult.errorCode,
        });
        continue;
      }

      // Success: SCORED
      const scored = procResult.scoreResult;
      // HARDENING: Never write SCORED with null score - treat as parse_failed
      if (!Number.isFinite(scored.aiScore)) {
        const nowIso = new Date().toISOString();
        applyParseFailed(
          signal,
          "null_score_from_model",
          undefined,
          nowIso
        );
        finalizedIds.push(signal.id);
        result.errored += 1;
        result.errorCount += 1;
        console.warn("[score/drain] score error: null score", {
          id: signal.id,
          ticker: signal.ticker,
        });
        continue;
      }
      applyScoreSuccess(signal, scored, new Date().toISOString());
      finalizedIds.push(signal.id);

      result.scored += 1;
      result.scoredCount += 1;
    }

    result.processed = concurrentResult.scoredCount + concurrentResult.errorCount;
    result.timeoutCount = concurrentResult.timeoutCount;
    result.details = concurrentResult.details;

    // CLEANUP: Release any unfinalized claims (signals stuck in SCORING)
    // releaseLimit controls how many to release: 0 = none, -1 = all, N > 0 = up to N
    const toRelease = claimedIds.filter(id => !finalizedIds.includes(id));
    const releaseCount = releaseLimit === 0 ? 0 : releaseLimit === -1 ? toRelease.length : Math.min(releaseLimit, toRelease.length);
    const toReleaseSliced = toRelease.slice(0, releaseCount);
    
    if (toReleaseSliced.length > 0) {
      console.log("[score/drain] releasing unfinalized claims", {
        count: toReleaseSliced.length,
        limit: releaseLimit,
        ids: toReleaseSliced,
      });
      for (const signal of signals) {
        if (toReleaseSliced.includes(signal.id) && signal.status === "SCORING") {
          signal.status = "PENDING";
          signal.scoringLockUntil = undefined;
          signal.scoringStartedAt = undefined;
          result.releasedCount += 1;
        }
      }
    }

    // Write updates (atomic for all signals processed so far)
    await writeSignals(signals);

    // Update funnel counters if any were scored
    if (result.scored > 0) {
      try {
        await bumpTodayFunnel({ gptScored: result.scored });
      } catch (err) {
        console.warn("[score/drain] funnel update error", err);
        // Non-fatal: don't fail the response
      }
    }

    // Touch heartbeat (non-fatal if it fails)
    try {
      await touchHeartbeat();
    } catch (err) {
      console.warn("[score/drain] heartbeat error", err);
    }

    console.log("[score/drain] complete", {
      processed: result.processed,
      scored: result.scored,
      errored: result.errored,
      timeoutCount: result.timeoutCount,
      expired: result.expired,
      durationMs: Date.now() - startedAtMs,
      remainingTimeMs: deadlineAtMs - Date.now(),
    });

    // Add selection strategy and window info to response
    result.pickedStrategy = pickedStrategy;
    result.recentWindowHours = recentWindowHours;
    result.newestPickedCreatedAt = newestPickedCreatedAt;
    result.oldestPickedCreatedAt = oldestPickedCreatedAt;
    result.remainingTimeMs = Math.max(0, deadlineAtMs - Date.now());
    return buildResponse(result, startedAtMs, 200);
  } catch (err) {
    // Unexpected error: still return JSON
    console.error("[score/drain] fatal error", err);
    result.ok = false;
    result.reason = String(err);
    return buildResponse(result, startedAtMs, 500);
  } finally {
    // CRITICAL: Always release lock, even on error or timeout
    if (lockAcquired) {
      await releaseDrainLock().catch((err) =>
        console.warn("[score/drain] lock release error", err)
      );
    }
  }
}
