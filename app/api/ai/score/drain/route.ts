import { NextResponse } from "next/server";
import { readSignals, writeSignals } from "@/lib/jsonDb";
import { redis } from "@/lib/redis";
import { bumpTodayFunnel } from "@/lib/funnelRedis";
import { scoreSignalWithAI } from "@/lib/aiScoring";
import { shouldQualify } from "@/lib/aiQualify";
import { touchHeartbeat } from "@/lib/aiHeartbeat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DRAIN_LOCK_KEY = "ai:score:drain:lock";
const DRAIN_LOCK_TTL = 30; // seconds

/**
 * Check cron token authorization
 */
function checkCronAuth(req: Request): { ok: boolean; reason?: string } {
  const token = req.headers.get("x-cron-token") || "";
  if (!process.env.CRON_TOKEN || token !== process.env.CRON_TOKEN) {
    return { ok: false, reason: "unauthorized" };
  }
  return { ok: true };
}

/**
 * Try to acquire a short-lived lock for drain to prevent parallel runs
 */
async function acquireDrainLock(): Promise<boolean> {
  if (!redis) return true; // Local mode: allow without lock
  try {
    const ok = await redis.set(DRAIN_LOCK_KEY, "1", { nx: true, ex: DRAIN_LOCK_TTL });
    return Boolean(ok);
  } catch (err) {
    console.error("[score/drain] lock acquire error", err);
    return false;
  }
}

/**
 * Release the drain lock
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
 * POST /api/ai/score/drain?limit=25
 *
 * Drain the PENDING signals queue by scoring up to `limit` signals.
 * - Acquires a Redis lock to avoid parallel drains
 * - Finds PENDING signals (recent-first, within last 24h)
 * - Scores each up to limit
 * - Marks as SCORED or ERROR (with error field) so signals don't stay PENDING forever
 * - Updates funnel counters gptScored, shownInApp, etc.
 * - Returns detailed telemetry about what was processed and any errors
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const limitParam = url.searchParams.get("limit");
  const limit = Math.min(
    Math.max(1, Number(limitParam) || 25),
    100
  ); // clamp between 1-100

  // Check authorization
  const auth = checkCronAuth(req);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: "unauthorized", reason: auth.reason },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  // Try to acquire lock
  const locked = await acquireDrainLock();
  if (!locked) {
    return NextResponse.json(
      {
        ok: false,
        error: "drain_already_running",
        message: "Another drain is already in progress",
      },
      { status: 429, headers: { "Cache-Control": "no-store" } }
    );
  }

  const startAt = new Date();
  const drainResult = {
    startedAt: startAt.toISOString(),
    processed: 0,
    scored: 0,
    errors: 0,
    skipped: 0,
    details: [] as Array<{
      id: string;
      ticker: string;
      status: "SCORED" | "ERROR" | "SKIPPED";
      reason?: string;
      error?: string;
      aiScore?: number | null;
    }>,
  };

  try {
    // Read all signals
    const signals = await readSignals();
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Find PENDING signals created within last 24 hours (recent first)
    const pendingSignals = signals
      .filter((s) => {
        if (s.status !== "PENDING") return false;
        const createdAt = new Date(s.createdAt);
        return createdAt >= oneDayAgo && createdAt <= now;
      })
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )
      .slice(0, limit);

    console.log(
      "[score/drain] processing",
      {
        totalSignals: signals.length,
        pendingCount: signals.filter((s) => s.status === "PENDING").length,
        willProcess: pendingSignals.length,
        limit,
      }
    );

    // Score each pending signal
    for (const signal of pendingSignals) {
      drainResult.processed += 1;

      try {
        // Score the signal
        const scoreResult = await scoreSignalWithAI({
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
        });

        if (!scoreResult.ok) {
          // Mark as ERROR with reason
          signal.status = "ERROR";
          signal.error = scoreResult.error;
          signal.aiErrorReason = scoreResult.reason;
          signal.updatedAt = new Date().toISOString();
          drainResult.errors += 1;
          drainResult.details.push({
            id: signal.id,
            ticker: signal.ticker,
            status: "ERROR",
            error: scoreResult.reason,
          });
          console.warn(
            "[score/drain] scoring failed",
            { id: signal.id, ticker: signal.ticker, error: scoreResult.reason }
          );
          continue;
        }

        const scored = scoreResult.scored;

        // Update signal with scored data
        signal.status = "SCORED";
        signal.aiScore = scored.aiScore ?? null;
        signal.aiGrade = scored.aiGrade ?? null;
        signal.aiSummary = scored.aiSummary ?? null;
        signal.totalScore = scored.totalScore ?? null;
        signal.tradePlan = scored.tradePlan ?? null;
        signal.qualified = shouldQualify({ score: scored.aiScore, grade: scored.aiGrade });
        signal.shownInApp = signal.qualified;
        signal.updatedAt = new Date().toISOString();

        drainResult.scored += 1;
        drainResult.details.push({
          id: signal.id,
          ticker: signal.ticker,
          status: "SCORED",
          aiScore: signal.aiScore,
        });

        console.log("[score/drain] scored", {
          id: signal.id,
          ticker: signal.ticker,
          aiScore: signal.aiScore,
          qualified: signal.qualified,
        });
      } catch (err) {
        // Unexpected error: mark as ERROR
        signal.status = "ERROR";
        signal.error = "unexpected_scoring_error";
        signal.aiErrorReason = String(err);
        signal.updatedAt = new Date().toISOString();
        drainResult.errors += 1;
        drainResult.details.push({
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

    // Write updated signals back
    await writeSignals(signals);

    // Bump funnel counters
    if (drainResult.scored > 0) {
      const qualifiedCount = signals.filter(
        (s) => s.status === "SCORED" && s.qualified
      ).length;
      const shownCount = signals.filter(
        (s) => s.status === "SCORED" && s.shownInApp
      ).length;

      await bumpTodayFunnel({
        gptScored: drainResult.scored,
        qualified: Math.max(0, qualifiedCount - drainResult.scored), // approximate increment
        shownInApp: Math.max(0, shownCount - drainResult.scored), // approximate increment
      });
    }

    // Touch heartbeat to indicate health
    await touchHeartbeat();

    const duration = new Date().getTime() - startAt.getTime();

    return NextResponse.json(
      {
        ok: true,
        drain: {
          ...drainResult,
          completedAt: new Date().toISOString(),
          durationMs: duration,
        },
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    console.error("[score/drain] fatal error", err);
    return NextResponse.json(
      {
        ok: false,
        error: "drain_fatal_error",
        message: String(err),
      },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  } finally {
    // Always release the lock
    await releaseDrainLock();
  }
}
