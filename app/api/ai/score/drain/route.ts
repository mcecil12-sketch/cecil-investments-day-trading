import { NextResponse } from "next/server";
import { readSignals, writeSignals } from "@/lib/jsonDb";
import { redis } from "@/lib/redis";
import { bumpTodayFunnel } from "@/lib/funnelRedis";
import { scoreSignalWithAI } from "@/lib/aiScoring";
import { touchHeartbeat } from "@/lib/aiHeartbeat";
import {
  applyInsufficientBars,
  applyParseFailed,
  applyScoreError,
  applyScoreSuccess,
  applyPreGptSkip,
} from "@/lib/ai/scoreDrainApply";
import { evaluateSignalEligibility, getEligibilityThresholds } from "@/lib/ai/eligibilityGates";
import { buildSignalContext } from "@/lib/signalContext";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120; // Allow up to 120s runtime on Vercel/Next.js

// Execution guards: wall-clock timeout and max signals per run
// budgetMs is passed as query param; we cap it at HARD_CAP_MS to respect maxDuration=120
const HARD_CAP_MS = 110000; // ~110s internal budget (maxDuration=120s with safety margin)
const SOFT_STOP_MARGIN_MS = 2000; // Stop starting new work when <2s remaining
const MAX_PER_RUN = Number(process.env.AI_SCORE_DRAIN_MAX ?? 100); // Safety cap: max signals per invocation
const SCORING_CONCURRENCY = Number(
  process.env.AI_SCORE_CONCURRENCY ?? process.env.AI_SCORE_DRAIN_CONCURRENCY ?? 5
); // Parallel scoring workers

// Fresh signal window configuration for live vs recovery modes
const AI_SCORE_FRESH_HOURS = Number(process.env.AI_SCORE_FRESH_HOURS ?? 24); // Window for live mode (default 24h)
const AI_SCORE_RECOVERY_HOURS = Number(process.env.AI_SCORE_RECOVERY_HOURS ?? 48); // Window for recovery mode (default 48h)

// Performance tuning: batching
// SCORE_DRAIN_BATCH_SIZE controls how many signals are scored per iteration of the loop.
// The drain loops until budget exhausted, MAX_PER_RUN reached, or no eligible signals remain.
const SCORE_DRAIN_BATCH_SIZE = Number(
  process.env.SCORE_DRAIN_BATCH_SIZE ?? process.env.AI_SCORE_BATCH_SIZE ?? 25
);
const AI_SCORE_MAX_CANDIDATE_SCAN = Number(process.env.AI_SCORE_MAX_CANDIDATE_SCAN ?? 200);

// Reclaim configuration
const RECLAIM_STALE_MINUTES = Number(process.env.SCORE_DRAIN_RECLAIM_MINUTES ?? 10);
const MAX_SCORING_RETRIES = Number(process.env.SCORE_DRAIN_MAX_RETRIES ?? 3);

const DRAIN_LOCK_KEY = "ai:score:drain:lock";
const DRAIN_LOCK_TTL_MAX = 120; // seconds
const CLAIM_TTL_SEC = 300; // 5 minutes per signal claim

/**
 * Try to acquire exclusive claim for a specific signal
 */
async function acquireSignalClaim(signalId: string): Promise<boolean> {
  if (!redis) return true; // Local mode: allow without lock
  try {
    const claimKey = `ai:score:claim:v1:${signalId}`;
    const ok = await redis.set(claimKey, "1", {
      nx: true,
      ex: CLAIM_TTL_SEC,
    });
    return Boolean(ok);
  } catch (err) {
    console.error("[score/drain] signal claim acquire error", err);
    return false;
  }
}

/**
 * Release exclusive claim for a specific signal
 */
async function releaseSignalClaim(signalId: string): Promise<void> {
  if (!redis) return;
  try {
    const claimKey = `ai:score:claim:v1:${signalId}`;
    await redis.del(claimKey);
  } catch (err) {
    console.warn("[score/drain] signal claim release error", err);
  }
}

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
      ex: Math.min(ttlSec, DRAIN_LOCK_TTL_MAX),
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

async function hydrateSignalContextIfNeeded(
  signal: any,
  minBarsRequired: number
): Promise<{ hydrated: boolean; failed: boolean }> {
  if (signal?.signalContext?.barsUsed != null) {
    return { hydrated: false, failed: false };
  }

  try {
    let context = await buildSignalContext({
      ticker: signal.ticker,
      timeframe: signal.timeframe || "1Min",
      limit: 90,
      endTimeIso: signal.createdAt,
    });

    if (context && context.barsUsed < minBarsRequired) {
      try {
        const retry = await buildSignalContext({
          ticker: signal.ticker,
          timeframe: signal.timeframe || "1Min",
          limit: 90,
        });
        if (retry && retry.barsUsed > context.barsUsed) {
          context = retry;
        }
      } catch (err) {
        console.log("[score/drain] signalContext retry failed", {
          id: signal?.id,
          ticker: signal?.ticker,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    signal.signalContext = context;
    return { hydrated: true, failed: false };
  } catch (err) {
    console.log("[score/drain] signalContext build failed", {
      id: signal?.id,
      ticker: signal?.ticker,
      error: err instanceof Error ? err.message : String(err),
    });
    return { hydrated: false, failed: true };
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
    // Check soft stop margin: if little time remains, stop starting new work
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

  // Parse query params and body early to compute deadline
  const url = new URL(req.url);
  const qp = url.searchParams;
  
  // Parse budgetMs from query param; cap at HARD_CAP_MS, default to 60000ms
  const budgetMsParam = Number(qp.get("budgetMs") ?? "60000");
  const budgetMs = Math.min(
    Number.isFinite(budgetMsParam) && budgetMsParam > 0 ? budgetMsParam : 60000,
    HARD_CAP_MS
  );
  const deadlineAtMs = startedAtMs + budgetMs;
  const deadlineMsConfigured = budgetMs;

  // Parse limit from query param first, then try body
  let bodyLimit: number | undefined;
  try {
    if (req.body) {
      const bodyJson = await req.json();
      if (typeof bodyJson === "object" && bodyJson !== null && "limit" in bodyJson) {
        bodyLimit = Number(bodyJson.limit);
      }
    }
  } catch {
    // Ignore JSON parse errors
  }

  const limitParamRaw = Number(qp.get("limit") ?? "NaN");
  const queryLimit =
    Number.isFinite(limitParamRaw) && limitParamRaw > 0 ? limitParamRaw : undefined;
  
  // Prefer query param, fallback to body, then use MAX_PER_RUN
  const effectiveLimit = queryLimit ?? (
    bodyLimit !== undefined && Number.isFinite(bodyLimit) && bodyLimit > 0 ? bodyLimit : undefined
  ) ?? MAX_PER_RUN;
  const maxPerRunComputed = Math.min(MAX_PER_RUN, effectiveLimit);
  // Per-iteration batch size: how many signals to score in each loop iteration
  const perIterationBatchSize = Math.max(1, Math.min(maxPerRunComputed, SCORE_DRAIN_BATCH_SIZE));
  // Scan deeper than per-run limit so pre-GPT skips don't starve scorer throughput
  const maxCandidateScan = Math.max(
    maxPerRunComputed * 2,
    Math.trunc(AI_SCORE_MAX_CANDIDATE_SCAN) || maxPerRunComputed * 2
  );

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
    skippedAlreadyClaimed: number;
    backlogBefore?: number;
    backlogAfter?: number;
    throughputPerSecond?: number;
    loopIterations?: number;
    details: Array<{
      id: string;
      ticker: string;
      status: "SCORED" | "ERROR" | "ARCHIVED";
      aiScore?: number | null;
      error?: string;
      skipReason?: string;
    }>;
    pickedStrategy?: "recent_first" | "backlog_fallback" | "backlog_oldest_first";
    recentWindowHours?: number;
    newestPickedCreatedAt?: string | null;
    oldestPickedCreatedAt?: string | null;
    deadlineMsConfigured?: number;
    softStopMarginMs?: number;
    effectiveLimit?: number;
    scanned?: number;
    eligible?: number;
    skippedStale?: number;
    skippedStatus?: number;
    mode?: "live" | "recovery";
    freshHoursUsed?: number;
    freshHoursSource?: "mode_default" | "query_override";
    // Pre-GPT gating skip counters
    skippedInsufficientBars?: number;
    skippedVolumeTooLow?: number;
    skippedDollarVolume?: number;
    skippedPriceTooLow?: number;
    skippedSpreadTooWide?: number;
    // Batch/diagnostics
    perIterationBatchSize?: number;
    candidateScanBudget?: number;
    selectedCount?: number;
    preGptSkipped?: number;
    skippedCount?: number;
    pendingScanned?: number;
    freshCandidatesAvailable?: number;
    freshCandidatesScanned?: number;
    claimedThisRun?: number;
    contextHydrated?: number;
    contextHydrationFailed?: number;
    sentToScorer?: number;
    persistedScored?: number;
    persistedError?: number;
    persistedArchived?: number;
    qualifiedPersisted?: number;
    shownInAppPersisted?: number;
    pipeline?: {
      pendingScanned: number;
      freshCandidatesScanned: number;
      claimedThisRun: number;
      reclaimedOldClaims: number;
      contextHydrated: number;
      contextHydrationFailed: number;
      preGptSkipped: number;
      sentToScorer: number;
      persistedScored: number;
      persistedError: number;
      persistedArchived: number;
      qualifiedPersisted: number;
      shownInAppPersisted: number;
    };
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
    skippedAlreadyClaimed: 0,
    backlogBefore: 0,
    backlogAfter: 0,
    throughputPerSecond: 0,
    loopIterations: 0,
    details: [],
    deadlineMsConfigured,
    softStopMarginMs: SOFT_STOP_MARGIN_MS,
    effectiveLimit: maxPerRunComputed,
    scanned: 0,
    eligible: 0,
    skippedStale: 0,
    skippedStatus: 0,
    skippedInsufficientBars: 0,
    skippedVolumeTooLow: 0,
    skippedDollarVolume: 0,
    skippedPriceTooLow: 0,
    skippedSpreadTooWide: 0,
    perIterationBatchSize,
    candidateScanBudget: maxCandidateScan,
    selectedCount: 0,
    preGptSkipped: 0,
    skippedCount: 0,
    pendingScanned: 0,
    freshCandidatesAvailable: 0,
    freshCandidatesScanned: 0,
    claimedThisRun: 0,
    contextHydrated: 0,
    contextHydrationFailed: 0,
    sentToScorer: 0,
    persistedScored: 0,
    persistedError: 0,
    persistedArchived: 0,
    qualifiedPersisted: 0,
    shownInAppPersisted: 0,
    pipeline: {
      pendingScanned: 0,
      freshCandidatesScanned: 0,
      claimedThisRun: 0,
      reclaimedOldClaims: 0,
      contextHydrated: 0,
      contextHydrationFailed: 0,
      preGptSkipped: 0,
      sentToScorer: 0,
      persistedScored: 0,
      persistedError: 0,
      persistedArchived: 0,
      qualifiedPersisted: 0,
      shownInAppPersisted: 0,
    },
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
    // --- AI scoring drain: prioritize fresh PENDING signals for real-time funnel health ---
    // Default live mode: only score signals within AI_SCORE_FRESH_HOURS window
    // Recovery mode (optional): score signals within AI_SCORE_RECOVERY_HOURS window
    const signals = await readSignals();
    const now = new Date();
    
    // Parse mode: "live" (default, fresh signals only) or "recovery" (broader window)
    const modeParam = (qp.get("mode") || "live").toLowerCase();
    const mode: "live" | "recovery" = ["recovery"].includes(modeParam) ? "recovery" : "live";
    
    // Determine fresh window based on mode
    const freshHoursUsed = mode === "recovery" ? AI_SCORE_RECOVERY_HOURS : AI_SCORE_FRESH_HOURS;
    const freshWindowStart = new Date(now.getTime() - freshHoursUsed * 60 * 60 * 1000);
    result.mode = mode;
    const recentWindowHoursParam = Number(qp.get("recentWindowHours") ?? "NaN");
    const hasRecentWindowOverride =
      Number.isFinite(recentWindowHoursParam) && recentWindowHoursParam > 0;
    const freshHoursOverride = hasRecentWindowOverride
      ? Math.max(1, Math.min(168, Math.trunc(recentWindowHoursParam)))
      : null;
    const effectiveFreshHours = freshHoursOverride ?? freshHoursUsed;
    result.freshHoursUsed = effectiveFreshHours;
    result.freshHoursSource = freshHoursOverride != null ? "query_override" : "mode_default";
    
    // Parse query params (budgetMs and limit already parsed above)
    const backlog = ["1", "true", "yes", "y", "on"].includes(
      (qp.get("backlog") || "").toLowerCase()
    );
    const strategyParam = (qp.get("strategy") || "").toLowerCase();
    const wantBacklogStrategy =
      backlog ||
      strategyParam === "backlog" ||
      strategyParam === "backlog_oldest_first";
    const releaseLimit = Number(qp.get("releaseLimit") ?? "-1"); // -1 = release all
    
    // Use fresh window for default live mode (no legacy backlog processing in normal drain)
    const RECENT_WINDOW_HOURS = effectiveFreshHours;

    // === RECLAIM STALE SCORING SIGNALS ===
    // Before picking new signals, reclaim stuck SCORING signals older than RECLAIM_STALE_MINUTES
    const scoringStaleThreshold = new Date(now.getTime() - RECLAIM_STALE_MINUTES * 60 * 1000);
    const staleScoring = signals.filter(
      (s) => s.status === "SCORING" && new Date(s.scoringStartedAt || s.createdAt) < scoringStaleThreshold
    );
    // Also reclaim CLAIMED signals (legacy status) older than threshold
    const staleClaimed = signals.filter(
      (s) => (s.status as string) === "CLAIMED" && new Date(s.scoringStartedAt || s.createdAt) < scoringStaleThreshold
    );
    const allStale = [...staleScoring, ...staleClaimed];

    for (const s of allStale.slice(0, 200)) {
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
    result.pipeline!.reclaimedOldClaims = result.reclaimedCount;

    // Check budget exhaustion BEFORE picking/claiming signals
    const elapsedBeforePick = Date.now() - startedAtMs;
    if (elapsedBeforePick > budgetMs) {
      result.expired = true;
      result.reason = "budget_exhausted";
      result.durationMs = Date.now() - startedAtMs;
      result.remainingTimeMs = Math.max(0, deadlineAtMs - Date.now());
      console.log("[score/drain] budget exhausted before picking", {
        elapsedBeforePick,
        budgetMs,
      });
      return buildResponse(result, startedAtMs, 200);
    }
    
    // Soft-stop guard: if low on time, don't attempt new work
    const remainingBeforePickMs = deadlineAtMs - Date.now();
    if (remainingBeforePickMs < SOFT_STOP_MARGIN_MS) {
      result.expired = true;
      result.reason = "deadline_soft_stop";
      result.durationMs = Date.now() - startedAtMs;
      result.remainingTimeMs = Math.max(0, remainingBeforePickMs);
      console.log("[score/drain] soft stop before picking", {
        remainingBeforePickMs,
        margin: SOFT_STOP_MARGIN_MS,
      });
      return buildResponse(result, startedAtMs, 200);
    }

    type PickStrategy = "recent_first" | "backlog_fallback" | "backlog_oldest_first";

    // Decide strategy (default stays recent_first with fresh window filtering)
    let pickedStrategy: PickStrategy = wantBacklogStrategy
      ? "backlog_oldest_first"
      : "recent_first";
    let allCandidates: any[] = [];

    // === BACKLOG TRACKING ===
    const backlogBefore = signals.filter((s) => s.status === "PENDING").length;
    result.backlogBefore = backlogBefore;

    if (pickedStrategy === "backlog_oldest_first") {
      // Backlog mode: pick oldest-first from ALL PENDING (legacy recovery)
      const pendingSignals = signals.filter((s) => s.status === "PENDING");
      result.pendingScanned = pendingSignals.length;
      result.scanned = pendingSignals.length;
      result.freshCandidatesAvailable = pendingSignals.length;
      allCandidates = [...pendingSignals]
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        .slice(0, maxCandidateScan);
    } else {
      // Default live mode: pick freshest signals within the live window first
      const pendingSignals = signals.filter((s) => s.status === "PENDING");
      result.scanned = pendingSignals.length;
      result.pendingScanned = pendingSignals.length;

      const freshPending = pendingSignals.filter(
        (s) => new Date(s.createdAt) >= freshWindowStart
      );
      result.eligible = freshPending.length;
      result.freshCandidatesAvailable = freshPending.length;

      // Count stale signals (outside fresh window)
      result.skippedStale = pendingSignals.length - freshPending.length;

      if (freshPending.length > 0) {
        allCandidates = [...freshPending]
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, maxCandidateScan);
      } else {
        console.log("[score/drain] fresh window empty, no signals to process", {
          mode: result.mode,
          freshHoursUsed,
          freshWindowStart: freshWindowStart.toISOString(),
        });
      }
    }

    // === MAIN PROCESSING LOOP ===
    // Processes signals in batches until budget exhausted, MAX_PER_RUN reached, or no candidates remain.
    // Each iteration: gate batch → claim → score → apply results → persist
    const nowIso = new Date().toISOString();
    const eligibilityThresholds = getEligibilityThresholds();
    const claimedIds: string[] = [];
    const finalizedIds: string[] = [];
    const preGptSkippedIds: string[] = [];
    let candidateIdx = 0;
    let totalSentToScorer = 0;
    let loopIterations = 0;

    console.log("[score/drain] start", {
      pickedStrategy,
      totalCandidates: allCandidates.length,
      backlogBefore,
      maxPerRun: maxPerRunComputed,
      perIterationBatchSize,
      budgetMs,
      hardCapMs: HARD_CAP_MS,
      softStopMarginMs: SOFT_STOP_MARGIN_MS,
      concurrency: SCORING_CONCURRENCY,
      recentWindowHours: RECENT_WINDOW_HOURS,
    });

    while (candidateIdx < allCandidates.length && totalSentToScorer < maxPerRunComputed) {
      // Check budget before starting new iteration
      const remainingMs = deadlineAtMs - Date.now();
      if (remainingMs < SOFT_STOP_MARGIN_MS) {
        result.expired = true;
        result.reason = "budget_soft_stop";
        console.log("[score/drain] soft stop in processing loop", {
          remainingMs,
          margin: SOFT_STOP_MARGIN_MS,
          loopIterations,
          totalSentToScorer,
          candidateIdx,
          totalCandidates: allCandidates.length,
        });
        break;
      }

      loopIterations++;
      const iterationStartMs = Date.now();

      // Determine batch size for this iteration (respect overall max)
      const iterBatchSize = Math.min(
        perIterationBatchSize,
        maxPerRunComputed - totalSentToScorer
      );

      // === Gate next batch of candidates ===
      const batchForScoring: any[] = [];
      while (batchForScoring.length < iterBatchSize && candidateIdx < allCandidates.length) {
        const signal = allCandidates[candidateIdx++];

        // Skip if status changed in a prior iteration (e.g., reclaimed then archived)
        if (signal.status !== "PENDING") continue;

        result.freshCandidatesScanned = (result.freshCandidatesScanned ?? 0) + 1;
        const hydration = await hydrateSignalContextIfNeeded(signal, eligibilityThresholds.minBars);
        if (hydration.hydrated) {
          result.contextHydrated = (result.contextHydrated ?? 0) + 1;
        }
        if (hydration.failed) {
          result.contextHydrationFailed = (result.contextHydrationFailed ?? 0) + 1;
        }

        const eligResult = evaluateSignalEligibility(
          signal.signalContext || null,
          signal.entryPrice,
          signal.createdAt,
          { staleAgeHours: freshHoursUsed }
        );

        if (!eligResult.eligible) {
          applyPreGptSkip(signal, eligResult.reason, eligResult.detail, nowIso);
          preGptSkippedIds.push(signal.id);
          result.preGptSkipped = (result.preGptSkipped ?? 0) + 1;
          result.persistedArchived = (result.persistedArchived ?? 0) + 1;

          switch (eligResult.reason) {
            case "insufficient_bars":
              result.skippedInsufficientBars = (result.skippedInsufficientBars ?? 0) + 1;
              break;
            case "volume_too_low":
              result.skippedVolumeTooLow = (result.skippedVolumeTooLow ?? 0) + 1;
              break;
            case "dollar_volume_too_low":
              result.skippedDollarVolume = (result.skippedDollarVolume ?? 0) + 1;
              break;
            case "price_too_low":
              result.skippedPriceTooLow = (result.skippedPriceTooLow ?? 0) + 1;
              break;
            case "spread_too_wide":
              result.skippedSpreadTooWide = (result.skippedSpreadTooWide ?? 0) + 1;
              break;
            case "stale":
              result.skippedStale = (result.skippedStale ?? 0) + 1;
              break;
          }

          finalizedIds.push(signal.id);
          continue;
        }

        batchForScoring.push(signal);
      }

      // If no eligible signals found, we've exhausted candidates
      if (batchForScoring.length === 0) {
        console.log("[score/drain] no eligible candidates remaining", {
          loopIterations,
          candidateIdx,
          totalCandidates: allCandidates.length,
          totalSentToScorer,
        });
        break;
      }

      // === Claim signals for scoring ===
      const claimUntil = new Date(Date.now() + 2 * 60 * 1000).toISOString();
      for (const signal of batchForScoring) {
        signal.status = "SCORING";
        signal.scoringLockUntil = claimUntil;
        signal.scoringStartedAt = nowIso;
        signal.updatedAt = nowIso;
        claimedIds.push(signal.id);
      }

      totalSentToScorer += batchForScoring.length;

      // Persist claims + pre-GPT archives before scoring
      await writeSignals(signals);

      console.log("[score/drain] loop iteration start", {
        iteration: loopIterations,
        batchSize: batchForScoring.length,
        totalSentToScorer,
        candidateIdx,
        remainingMs: deadlineAtMs - Date.now(),
        maxPerRun: maxPerRunComputed,
        timeSpentMs: Date.now() - startedAtMs,
      });

      // === Score this batch ===
      const concurrentResult = await scoreSignalsConcurrent(
        batchForScoring,
        deadlineAtMs,
        SCORING_CONCURRENCY
      );

      // === Apply scoring results ===
      for (const procResult of concurrentResult.results) {
        const signal = procResult.signal;
        result.attemptedCount += 1;

        if (procResult.status === "TIMEOUT") {
          // Retry logic: revert to PENDING for next drain run, up to MAX_SCORING_RETRIES
          const attempts = (signal.scoringAttempts ?? 0) + 1;
          signal.scoringAttempts = attempts;

          if (attempts >= MAX_SCORING_RETRIES) {
            // Exhausted retries: finalize as error
            const nowIso2 = new Date().toISOString();
            applyScoreError(signal, `timeout_after_${attempts}_attempts`, nowIso2, "timeout");
            finalizedIds.push(signal.id);
            result.errored += 1;
            result.errorCount += 1;
            result.persistedError = (result.persistedError ?? 0) + 1;
            console.warn("[score/drain] timeout finalized after max retries", {
              id: signal.id,
              ticker: signal.ticker,
              attempts,
            });
          } else {
            // Revert to PENDING for retry on next run
            signal.status = "PENDING";
            signal.scoringLockUntil = undefined;
            signal.scoringStartedAt = undefined;
            signal.updatedAt = new Date().toISOString();
            console.log("[score/drain] timeout reverted to PENDING for retry", {
              id: signal.id,
              ticker: signal.ticker,
              attempts,
              maxRetries: MAX_SCORING_RETRIES,
            });
          }

          result.timeoutCount += 1;
          await releaseSignalClaim(signal.id);
          continue;
        }

        result.completedCount += 1;

        if (procResult.status === "ERROR") {
          const nowIso2 = new Date().toISOString();
          if (procResult.errorCode === "insufficient_bars") {
            applyInsufficientBars(signal, procResult.errorReason || "Insufficient recent bars", nowIso2);
            finalizedIds.push(signal.id);
            result.persistedArchived = (result.persistedArchived ?? 0) + 1;
            await releaseSignalClaim(signal.id);
            continue;
          } else if (procResult.errorCode === "parse_failed") {
            applyParseFailed(
              signal,
              procResult.errorReason || "unparseable",
              procResult.errorMeta,
              nowIso2
            );
          } else if (procResult.errorCode === "breaker_open" || procResult.errorCode === "rate_limit") {
            // Transient failure: revert to PENDING for retry
            signal.status = "PENDING";
            signal.scoringLockUntil = undefined;
            signal.scoringStartedAt = undefined;
            signal.scoringAttempts = (signal.scoringAttempts ?? 0) + 1;
            signal.updatedAt = new Date().toISOString();
            result.errorCount += 1;
            await releaseSignalClaim(signal.id);
            console.log("[score/drain] transient error reverted to PENDING", {
              id: signal.id,
              ticker: signal.ticker,
              errorCode: procResult.errorCode,
            });
            continue;
          } else {
            applyScoreError(signal, procResult.errorReason, nowIso2, procResult.errorCode);
          }

          finalizedIds.push(signal.id);
          await releaseSignalClaim(signal.id);
          result.errored += 1;
          result.errorCount += 1;
          result.persistedError = (result.persistedError ?? 0) + 1;
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
          const nowIso2 = new Date().toISOString();
          applyParseFailed(
            signal,
            "null_score_from_model",
            undefined,
            nowIso2
          );
          finalizedIds.push(signal.id);
          await releaseSignalClaim(signal.id);
          result.errored += 1;
          result.errorCount += 1;
          result.persistedError = (result.persistedError ?? 0) + 1;
          console.warn("[score/drain] score error: null score", {
            id: signal.id,
            ticker: signal.ticker,
          });
          continue;
        }
        applyScoreSuccess(signal, scored, new Date().toISOString());
        finalizedIds.push(signal.id);
        await releaseSignalClaim(signal.id);

        result.scored += 1;
        result.scoredCount += 1;
        result.persistedScored = (result.persistedScored ?? 0) + 1;
      }

      // Persist progress after each iteration (crash recovery)
      await writeSignals(signals);

      // Check if we should continue the loop
      const iterDurationMs = Date.now() - iterationStartMs;
      const postIterRemainingMs = deadlineAtMs - Date.now();

      console.log("[score/drain] loop iteration complete", {
        iteration: loopIterations,
        batchScored: concurrentResult.scoredCount,
        batchErrors: concurrentResult.errorCount,
        batchTimeouts: concurrentResult.timeoutCount,
        iterDurationMs,
        totalSentToScorer,
        postIterRemainingMs,
        timeSpentMs: Date.now() - startedAtMs,
      });

      // If soft stop reached or too many timeouts in this batch, break
      if (postIterRemainingMs < SOFT_STOP_MARGIN_MS) {
        result.expired = true;
        result.reason = "budget_soft_stop";
        break;
      }
      if (concurrentResult.timeoutCount > 0 && concurrentResult.timeoutCount >= batchForScoring.length) {
        // All signals in this batch timed out - stop to avoid wasting budget
        result.expired = true;
        result.reason = "batch_all_timeout";
        console.log("[score/drain] stopping: all signals in batch timed out");
        break;
      }
    }

    // === POST-LOOP METRICS ===
    result.loopIterations = loopIterations;
    result.claimedThisRun = claimedIds.length;
    result.selectedCount = totalSentToScorer;
    result.sentToScorer = totalSentToScorer;
    result.pipeline!.pendingScanned = result.pendingScanned ?? 0;
    result.pipeline!.freshCandidatesScanned = result.freshCandidatesScanned ?? 0;
    result.pipeline!.claimedThisRun = claimedIds.length;
    result.pipeline!.contextHydrated = result.contextHydrated ?? 0;
    result.pipeline!.contextHydrationFailed = result.contextHydrationFailed ?? 0;
    result.pipeline!.preGptSkipped = result.preGptSkipped ?? 0;
    result.pipeline!.sentToScorer = totalSentToScorer;

    // For response visibility: compute createdAt range
    const newestPickedCreatedAt = allCandidates.length > 0
      ? allCandidates.reduce((max, s) => (new Date(s.createdAt) > new Date(max) ? s.createdAt : max), allCandidates[0].createdAt)
      : null;
    const oldestPickedCreatedAt = allCandidates.length > 0
      ? allCandidates.reduce((min, s) => (new Date(s.createdAt) < new Date(min) ? s.createdAt : min), allCandidates[0].createdAt)
      : null;

    result.processed =
      (result.persistedScored ?? 0) +
      (result.persistedError ?? 0) +
      (result.persistedArchived ?? 0);
    result.skippedCount =
      (result.preGptSkipped ?? 0) +
      result.timeoutCount +
      result.skippedAlreadyClaimed +
      result.releasedCount;

    // Rebuild details from actual persisted signal state (post-apply)
    const finalizedSignals = signals.filter((s) => finalizedIds.includes(s.id));
    result.details = finalizedSignals.slice(0, 20).map((s) => ({
      id: s.id,
      ticker: s.ticker,
      status: (s.status === "SCORED" || s.status === "ERROR" || s.status === "ARCHIVED")
        ? s.status
        : "ERROR",
      aiScore: s.status === "SCORED" ? s.aiScore : undefined,
      error: s.status === "ERROR" ? (s.error ?? undefined) : undefined,
      skipReason: s.status === "ARCHIVED" ? ((s as any).skipReason ?? undefined) : undefined,
    }));

    // CLEANUP: Release any unfinalized claims (signals stuck in SCORING)
    // releaseLimit controls how many to release: 0 = none, -1 = all, N > 0 = up to N
    // STRICT LIMIT: Never release more than actually claimed this run.
    const toRelease = claimedIds.filter((id) => !finalizedIds.includes(id));
    const claimedThisRun = claimedIds.length;
    const effectiveReleaseLimit =
      releaseLimit === 0
        ? 0
        : releaseLimit === -1
          ? Math.min(toRelease.length, claimedThisRun)
          : Math.min(releaseLimit, claimedThisRun);
    const toReleaseSliced = toRelease.slice(0, effectiveReleaseLimit);

    if (toReleaseSliced.length > 0) {
      console.log("[score/drain] releasing unfinalized claims", {
        count: toReleaseSliced.length,
        limit: releaseLimit,
        claimedThisRun,
        effectiveReleaseLimit,
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

    // === WRITE GUARD: Enforce invariant SCORED → aiScore is finite ===
    // Before persisting, verify that no SCORED signal has null/undefined/NaN aiScore.
    // If a violation is detected, convert to ERROR to maintain data integrity.
    const guardsApplied = [];
    for (const sig of signals.filter((s) => finalizedIds.includes(s.id))) {
      const signal = sig as any; // Allow dynamic properties like scoredAt
      if (signal.status === "SCORED" && !Number.isFinite(signal.aiScore)) {
        const invalidAiScore = signal.aiScore;
        console.warn("[score/drain] write guard: SCORED signal has non-finite aiScore, converting to ERROR", {
          id: signal.id,
          ticker: signal.ticker,
          aiScore: invalidAiScore,
        });

        // Determine which error code to use based on aiSummary or default to parse_failed
        const isInsufficientBarsError = 
          signal.aiSummary?.includes("Insufficient") || 
          signal.error === "insufficient_bars";
        
        if (isInsufficientBarsError) {
          // Archive as skip, not error
          signal.status = "ARCHIVED";
          signal.skipReason = "insufficient_bars";
          signal.qualified = false;
          signal.shownInApp = false;
          delete signal.error;
        } else {
          signal.status = "ERROR";
          signal.error = "parse_failed";
        }
        
        signal.aiScore = 0;
        signal.aiGrade = "F";
        signal.aiSummary = `guard: non-finite aiScore (was ${String(invalidAiScore)})`;
        signal.scoredAt = new Date().toISOString();
        signal.updatedAt = new Date().toISOString();

        // Clear score-related fields for consistency
        delete signal.score;
        delete signal.grade;
        delete signal.totalScore;
        delete signal.tradePlan;

        guardsApplied.push({
          id: signal.id,
          ticker: signal.ticker,
          status: signal.status,
          skipReason: signal.skipReason || null,
          error: signal.error || null,
        });

        // Update result counters to reflect the correction
        result.scored -= 1;
        result.scoredCount -= 1;
        result.errored += 1;
        result.errorCount += 1;
        result.persistedScored = Math.max(0, (result.persistedScored ?? 0) - 1);
        if (signal.status === "ARCHIVED") {
          result.persistedArchived = (result.persistedArchived ?? 0) + 1;
        } else {
          result.persistedError = (result.persistedError ?? 0) + 1;
        }
      }
    }

    result.pipeline!.persistedScored = result.persistedScored ?? 0;
    result.pipeline!.persistedError = result.persistedError ?? 0;
    result.pipeline!.persistedArchived = result.persistedArchived ?? 0;

    const finalizedPersistedSignals = signals.filter((s) => finalizedIds.includes(s.id));
    const qualifiedPersistedCount = finalizedPersistedSignals.filter(
      (s) => s.status === "SCORED" && s.qualified === true
    ).length;
    const shownInAppPersistedCount = finalizedPersistedSignals.filter(
      (s) => s.status === "SCORED" && s.shownInApp === true
    ).length;

    result.qualifiedPersisted = qualifiedPersistedCount;
    result.shownInAppPersisted = shownInAppPersistedCount;
    result.pipeline!.qualifiedPersisted = qualifiedPersistedCount;
    result.pipeline!.shownInAppPersisted = shownInAppPersistedCount;

    if (guardsApplied.length > 0) {
      console.warn("[score/drain] write guard applied corrections", {
        count: guardsApplied.length,
        corrections: guardsApplied,
      });
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
    
    // Track drain metrics + pre-GPT skipping
    try {
      await bumpTodayFunnel({
        drainsRun: 1,
        drainScored: result.scoredCount,
        drainTimeout: result.timeoutCount,
        drainError: result.errorCount,
        drainClaimedThisRun: result.claimedThisRun ?? 0,
        drainSentToScorer: result.sentToScorer ?? 0,
        drainPersistedScored: result.persistedScored ?? 0,
        drainPersistedArchived: result.persistedArchived ?? 0,
        drainPersistedError: result.persistedError ?? 0,
        drainPreGptSkipped: result.preGptSkipped ?? 0,
        drainSkippedInsufficientBars: result.skippedInsufficientBars ?? 0,
        drainSkippedVolumeTooLow: result.skippedVolumeTooLow ?? 0,
        drainSkippedDollarVolume: result.skippedDollarVolume ?? 0,
        drainSkippedPriceTooLow: result.skippedPriceTooLow ?? 0,
        drainSkippedSpreadTooWide: result.skippedSpreadTooWide ?? 0,
        qualified: result.qualifiedPersisted ?? 0,
        shownInApp: result.shownInAppPersisted ?? 0,
      });
    } catch (err) {
      console.warn("[score/drain] drain metrics update error", err);
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
      persistedArchived: result.persistedArchived,
      timeoutCount: result.timeoutCount,
      skippedCount: result.skippedCount,
      expired: result.expired,
      loopIterations: result.loopIterations,
      backlogBefore: result.backlogBefore,
      durationMs: Date.now() - startedAtMs,
      remainingTimeMs: deadlineAtMs - Date.now(),
    });

    // === FINAL METRICS ===
    const backlogAfter = signals.filter((s) => s.status === "PENDING").length;
    result.backlogAfter = backlogAfter;
    const totalDurationMs = Date.now() - startedAtMs;
    const totalDurationSec = totalDurationMs / 1000;
    result.throughputPerSecond = totalDurationSec > 0
      ? Math.round((result.processed / totalDurationSec) * 100) / 100
      : 0;

    // Add selection strategy and window info to response
    result.pickedStrategy = pickedStrategy;
    result.recentWindowHours = RECENT_WINDOW_HOURS;
    result.newestPickedCreatedAt = newestPickedCreatedAt;
    result.oldestPickedCreatedAt = oldestPickedCreatedAt;
    result.remainingTimeMs = Math.max(0, deadlineAtMs - Date.now());
    
    // Add drain-specific response fields
    const response = {
      ...result,
      budgetMs,
      effectiveLimit: maxPerRunComputed,
    };
    
    return NextResponse.json(response, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
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
