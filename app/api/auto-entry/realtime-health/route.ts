/**
 * GET /api/auto-entry/realtime-health
 *
 * Diagnostic endpoint for the real-time in-process seed path (score-drain-realtime).
 * Returns today's counters and the most recent real-time seed attempt from signals.
 */

import { NextResponse } from "next/server";
import { readTodayFunnel } from "@/lib/funnelRedis";
import { readSignals } from "@/lib/jsonDb";
import { getEtDateString } from "@/lib/time/etDate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
  Expires: "0",
};

function num(val: unknown): number {
  return typeof val === "number" && Number.isFinite(val) ? val : 0;
}

function minutesSince(iso?: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.round((Date.now() - t) / 60000);
}

export async function GET() {
  const etDate = getEtDateString();

  try {
    const [funnelData, allSignals] = await Promise.all([
      readTodayFunnel(),
      readSignals().catch(() => [] as Awaited<ReturnType<typeof readSignals>>),
    ]);

    // Find signals that had a real-time seed attempt today
    const rtAttemptedSignals = (allSignals || [])
      .filter((s: any) => typeof s?.realTimeSeedAttemptedAt === "string")
      .sort((a: any, b: any) => {
        const aMs = Date.parse(a.realTimeSeedAttemptedAt || "") || 0;
        const bMs = Date.parse(b.realTimeSeedAttemptedAt || "") || 0;
        return bMs - aMs; // newest first
      })
      .slice(0, 20);

    const lastAttempt = rtAttemptedSignals[0] as any ?? null;

    const recentAttempts = rtAttemptedSignals.map((s: any) => ({
      signalId: String(s?.id || ""),
      symbol: String(s?.ticker || s?.symbol || ""),
      attemptedAt: s?.realTimeSeedAttemptedAt ?? null,
      minutesSinceAttempt: minutesSince(s?.realTimeSeedAttemptedAt),
      tradeId: s?.realTimeSeedTradeId ?? null,
      skippedReason: s?.realTimeSeedSkippedReason ?? null,
      executeTriggered: s?.realTimeExecuteTriggered ?? null,
      executeSkippedReason: s?.realTimeExecuteSkippedReason ?? null,
      seeded: !s?.realTimeSeedSkippedReason,
      aiScore: s?.aiScore ?? null,
      tier: s?.aiGrade ?? null,
      scoredAt: s?.scoredAt ?? null,
      createdAt: s?.createdAt ?? null,
    }));

    // Counters from Redis
    const counters = {
      realTimeSeedAttempted: num(funnelData.realTimeSeedAttemptedCount),
      realTimeSeeded: num(funnelData.seedRealTimeSeeded),
      immediateExecuteTriggered: num(funnelData.seedImmediateExecuteTriggered),
      immediateExecuteSucceeded: num(funnelData.immediateExecuteSucceededCount),
      immediateExecuteSkipped: num(funnelData.immediateExecuteSkippedCount),
      // Backup (HP queue) path
      highPriorityEnqueued: num(funnelData.seedHighPriorityEnqueued),
      highPriorityDequeued: num(funnelData.seedHighPriorityDequeued),
    };

    // Skip reason summary from recentAttempts
    const skipReasonCounts: Record<string, number> = {};
    for (const a of recentAttempts) {
      if (a.skippedReason) {
        skipReasonCounts[a.skippedReason] = (skipReasonCounts[a.skippedReason] ?? 0) + 1;
      }
    }
    const topSkipReason = Object.entries(skipReasonCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    const successRate =
      counters.realTimeSeedAttempted > 0
        ? Math.round((counters.realTimeSeeded / counters.realTimeSeedAttempted) * 100)
        : null;

    const executeSuccessRate =
      counters.immediateExecuteTriggered > 0
        ? Math.round((counters.immediateExecuteSucceeded / counters.immediateExecuteTriggered) * 100)
        : null;

    return NextResponse.json(
      {
        etDate,
        timestamp: new Date().toISOString(),
        counters,
        successRate,
        executeSuccessRate,
        topSkipReason,
        skipReasonCounts,
        lastAttemptAt: lastAttempt?.realTimeSeedAttemptedAt ?? null,
        minutesSinceLastAttempt: minutesSince(lastAttempt?.realTimeSeedAttemptedAt),
        lastAttemptSeeded: lastAttempt ? !lastAttempt.realTimeSeedSkippedReason : null,
        lastAttemptSkipReason: lastAttempt?.realTimeSeedSkippedReason ?? null,
        lastAttemptTradeId: lastAttempt?.realTimeSeedTradeId ?? null,
        lastAttemptSymbol: lastAttempt
          ? String(lastAttempt?.ticker || lastAttempt?.symbol || "")
          : null,
        recentAttempts,
      },
      { headers: CACHE_HEADERS },
    );
  } catch (err) {
    return NextResponse.json(
      { error: String(err || "internal_error"), etDate },
      { status: 500, headers: CACHE_HEADERS },
    );
  }
}
