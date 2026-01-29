import { NextResponse } from "next/server";
import { readSignals, writeSignals } from "@/lib/jsonDb";
import { redis } from "@/lib/redis";
import { bumpTodayFunnel } from "@/lib/funnelRedis";
import { scoreSignalWithAI } from "@/lib/aiScoring";
import { shouldQualify } from "@/lib/aiQualify";
import { touchHeartbeat } from "@/lib/aiHeartbeat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Execution guards: wall-clock timeout and max signals per run
const DEADLINE_MS = Number(process.env.AI_SCORE_DRAIN_DEADLINE_MS ?? 8000);
const MAX_PER_RUN = Number(process.env.AI_SCORE_DRAIN_MAX ?? 25);

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
  | { ok: true; scored: any }
  | { ok: false; error: string; reason: string }
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

    return result;
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
    releasedCount: number;
    reclaimedCount: number;
    details: Array<{
      id: string;
      ticker: string;
      status: "SCORED" | "ERROR";
      aiScore?: number | null;
      error?: string;
    }>;
    pickedStrategy?: "recent_first" | "backlog_fallback";
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
    releasedCount: 0,
    reclaimedCount: 0,
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

    // 1. Try to pick newest PENDING signals within the recent window
    let pickedStrategy: "recent_first" | "backlog_fallback" = "recent_first";
    let pickedSignals = signals
      .filter((s) => s.status === "PENDING" && new Date(s.createdAt) >= recentWindowStart)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, MAX_PER_RUN);

    // 2. Fallback: if none in recent window, pick newest PENDING from full backlog
    if (pickedSignals.length === 0) {
      pickedStrategy = "backlog_fallback";
      pickedSignals = signals
        .filter((s) => s.status === "PENDING")
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, MAX_PER_RUN);
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

    // For response visibility
    const recentWindowHours = RECENT_WINDOW_HOURS;
    const newestPickedCreatedAt = pickedSignals[0]?.createdAt || null;
    const oldestPickedCreatedAt = pickedSignals.length > 0 ? pickedSignals[pickedSignals.length - 1].createdAt : null;

    console.log("[score/drain] start", {
      pickedStrategy,
      pickedCount: pickedSignals.length,
      maxPerRun: MAX_PER_RUN,
      deadlineMs: DEADLINE_MS,
      recentWindowHours,
      newestPickedCreatedAt,
      oldestPickedCreatedAt,
    });

    // Process signals sequentially (NOT Promise.all)
    let actuallyProcessed = 0;
    for (const signal of pickedSignals) {
      // Check deadline BEFORE processing each signal
      if (isExpired()) {
        result.expired = true;
        // Revert any remaining SCORING signals to PENDING (not processed)
        for (let i = actuallyProcessed; i < pickedSignals.length; ++i) {
          const s = pickedSignals[i];
          if (s.status === "SCORING") {
            s.status = "PENDING";
            s.scoringLockUntil = undefined;
            s.updatedAt = new Date().toISOString();
          }
        }
        await writeSignals(signals);
        console.log("[score/drain] deadline expired", {
          processed: result.processed,
          scored: result.scored,
          errored: result.errored,
          durationMs: Date.now() - startedAtMs,
        });
        break;
      }

      result.processed += 1;
      actuallyProcessed += 1;

      try {
        // Wrap AI call in timeout to avoid hanging
        const scoreResult = await scoreWithTimeout(signal, deadlineAtMs);

        if (!scoreResult.ok) {
          // If the error is a deadline_exceeded, do NOT mark as ERROR, just break (leave as SCORING, will revert if expired)
          if (scoreResult.reason === "deadline_exceeded") {
            result.expired = true;
            break;
          }
          // If the error is a model timeout, mark as ERROR: model_timeout
          const isTimeout = scoreResult.error === "timeout";
          signal.status = "ERROR";
          signal.error = isTimeout ? "model_timeout" : scoreResult.error;
          signal.aiErrorReason = scoreResult.reason;
          signal.updatedAt = new Date().toISOString();
          signal.scoringLockUntil = undefined;
          signal.scoringStartedAt = undefined;
          finalizedIds.push(signal.id);
          result.errored += 1;
          result.details.push({
            id: signal.id,
            ticker: signal.ticker,
            status: "ERROR",
            error: isTimeout ? "model_timeout" : scoreResult.reason,
          });
          console.warn("[score/drain] score error", {
            id: signal.id,
            ticker: signal.ticker,
            reason: scoreResult.reason,
          });
          continue;
        }

        const scored = scoreResult.scored;

        // Mark as SCORED
        signal.status = "SCORED";
        signal.aiScore = scored.aiScore ?? null;
        signal.aiGrade = scored.aiGrade ?? null;
        signal.aiSummary = scored.aiSummary ?? null;
        signal.totalScore = scored.totalScore ?? null;
        signal.tradePlan = scored.tradePlan ?? null;
        signal.qualified = shouldQualify({
          score: scored.aiScore,
          grade: scored.aiGrade,
        });
        signal.shownInApp = signal.qualified;
        signal.updatedAt = new Date().toISOString();
        signal.scoringLockUntil = undefined;
        signal.scoringStartedAt = undefined;
        finalizedIds.push(signal.id);

        result.scored += 1;
        result.details.push({
          id: signal.id,
          ticker: signal.ticker,
          status: "SCORED",
          aiScore: signal.aiScore,
        });
      } catch (err) {
        // Unexpected error: mark as ERROR (never PENDING)
        signal.status = "ERROR";
        signal.error = "unexpected_error";
        signal.aiErrorReason = String(err);
        signal.updatedAt = new Date().toISOString();
        signal.scoringLockUntil = undefined;
        signal.scoringStartedAt = undefined;
        finalizedIds.push(signal.id);
        result.errored += 1;
        result.details.push({
          id: signal.id,
          ticker: signal.ticker,
          status: "ERROR",
          error: String(err),
        });
        console.error("[score/drain] unexpected error", {
          id: signal.id,
          ticker: signal.ticker,
          error: err,
        });
      }
    }

    // CLEANUP: Release any unfinalized claims (signals stuck in SCORING)
    const toRelease = claimedIds.filter(id => !finalizedIds.includes(id));
    if (toRelease.length > 0) {
      console.log("[score/drain] releasing unfinalized claims", {
        count: toRelease.length,
        ids: toRelease,
      });
      for (const signal of signals) {
        if (toRelease.includes(signal.id) && signal.status === "SCORING") {
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
      expired: result.expired,
      durationMs: Date.now() - startedAtMs,
    });

    // Add selection strategy and window info to response
    result.pickedStrategy = pickedStrategy;
    result.recentWindowHours = recentWindowHours;
    result.newestPickedCreatedAt = newestPickedCreatedAt;
    result.oldestPickedCreatedAt = oldestPickedCreatedAt;
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
