/**
 * Grade-Based Trade Telemetry
 * 
 * Tracks performance metrics segmented by AI signal grade:
 * - Win rate by grade (A/B/C)
 * - Average R by grade
 * - R distribution histogram
 * - Total trades by grade
 * - Runner success rate (trades reaching 3R+ by grade)
 */

import { redis } from "@/lib/redis";

const KEY_GRADE_STATS = "telemetry:trades:grade-stats";
const KEY_R_DISTRIBUTION = "telemetry:trades:r-distribution";

const hasRedis = () => !!redis;

export type TradeCloseEvent = {
  tradeId: string;
  ticker: string;
  grade: string; // A+, A, B, C, D, F
  side: "LONG" | "SHORT";
  realizedR: number;
  realizedPnL: number;
  closeReason: string; // stop_hit, take_profit_hit, trail_exit, manual, etc.
  closedAt: string;
  entryPrice: number;
  exitPrice: number;
  holdDurationMinutes?: number;
};

/**
 * Record a closed trade for grade-based analysis
 */
export async function recordTradeClose(event: TradeCloseEvent) {
  if (!hasRedis()) return;

  const grade = event.grade.toUpperCase();
  const isWin = event.realizedR > 0;
  const isRunner = event.realizedR >= 3.0; // 3R+ = runner
  const rBucket = getRBucket(event.realizedR);

  try {
    const pipe = redis!.multi();

    // Per-grade stats
    const gradeKey = `grade:${grade}`;
    pipe.hincrby(KEY_GRADE_STATS, `${gradeKey}:total`, 1);
    if (isWin) pipe.hincrby(KEY_GRADE_STATS, `${gradeKey}:wins`, 1);
    if (isRunner) pipe.hincrby(KEY_GRADE_STATS, `${gradeKey}:runners`, 1);
    pipe.hincrbyfloat(KEY_GRADE_STATS, `${gradeKey}:totalR`, event.realizedR);
    pipe.hincrbyfloat(KEY_GRADE_STATS, `${gradeKey}:totalPnL`, event.realizedPnL);

    // Close reason tracking by grade
    const reasonKey = `${gradeKey}:closeReason:${event.closeReason}`;
    pipe.hincrby(KEY_GRADE_STATS, reasonKey, 1);

    // Direction tracking by grade
    const sideKey = `${gradeKey}:side:${event.side}`;
    pipe.hincrby(KEY_GRADE_STATS, sideKey, 1);

    // R distribution histogram (all grades combined)
    pipe.hincrby(KEY_R_DISTRIBUTION, rBucket, 1);
    pipe.hincrby(KEY_R_DISTRIBUTION, `${rBucket}:${grade}`, 1);

    // Global stats
    pipe.hset(KEY_GRADE_STATS, {
      lastTradeClosedAt: event.closedAt,
      lastTradeTicker: event.ticker,
      lastTradeGrade: grade,
      lastTradeR: event.realizedR,
    });

    await pipe.exec();
  } catch (err) {
    console.error("[gradeTelemetry] Failed to record trade close:", err);
  }
}

/**
 * Get R bucket for histogram (e.g., "-2to-1", "0to1", "3to4")
 */
function getRBucket(r: number): string {
  if (r < -2) return "<-2R";
  if (r < -1) return "-2to-1R";
  if (r < 0) return "-1to0R";
  if (r < 1) return "0to1R";
  if (r < 2) return "1to2R";
  if (r < 3) return "2to3R";
  if (r < 5) return "3to5R";
  if (r < 10) return "5to10R";
  return ">10R";
}

/**
 * Read grade-based performance stats
 */
export async function readGradeStats() {
  if (!hasRedis()) {
    return {
      ok: true,
      grades: {},
      rDistribution: {},
      redis: false,
    };
  }

  try {
    const [stats, rDist] = await Promise.all([
      redis!.hgetall(KEY_GRADE_STATS),
      redis!.hgetall(KEY_R_DISTRIBUTION),
    ]);

    // Parse per-grade stats
    const grades: Record<string, any> = {};
    const gradePattern = /^grade:([A-F]\+?):/;

    for (const [key, value] of Object.entries(stats || {})) {
      const match = key.match(gradePattern);
      if (!match) continue;

      const grade = match[1];
      if (!grades[grade]) {
        grades[grade] = {
          grade,
          total: 0,
          wins: 0,
          losses: 0,
          runners: 0,
          totalR: 0,
          totalPnL: 0,
          avgR: 0,
          winRate: 0,
          runnerRate: 0,
          closeReasons: {},
          sides: {},
        };
      }

      // Extract metric type
      const metricKey = key.replace(gradePattern, "");
      if (metricKey === "total") grades[grade].total = Number(value);
      if (metricKey === "wins") grades[grade].wins = Number(value);
      if (metricKey === "runners") grades[grade].runners = Number(value);
      if (metricKey === "totalR") grades[grade].totalR = Number(value);
      if (metricKey === "totalPnL") grades[grade].totalPnL = Number(value);
      
      if (metricKey.startsWith("closeReason:")) {
        const reason = metricKey.replace("closeReason:", "");
        grades[grade].closeReasons[reason] = Number(value);
      }
      
      if (metricKey.startsWith("side:")) {
        const side = metricKey.replace("side:", "");
        grades[grade].sides[side] = Number(value);
      }
    }

    // Calculate derived metrics
    for (const grade of Object.keys(grades)) {
      const g = grades[grade];
      g.losses = g.total - g.wins;
      g.avgR = g.total > 0 ? g.totalR / g.total : 0;
      g.winRate = g.total > 0 ? g.wins / g.total : 0;
      g.runnerRate = g.total > 0 ? g.runners / g.total : 0;
    }

    // Parse R distribution
    const rDistribution: Record<string, number> = {};
    for (const [bucket, count] of Object.entries(rDist || {})) {
      if (!bucket.includes(":")) {
        // Only top-level buckets (not grade-specific)
        rDistribution[bucket] = Number(count);
      }
    }

    return {
      ok: true,
      grades,
      rDistribution,
      lastTradeClosedAt: stats?.lastTradeClosedAt,
      lastTradeTicker: stats?.lastTradeTicker,
      lastTradeGrade: stats?.lastTradeGrade,
      lastTradeR: stats?.lastTradeR ? Number(stats.lastTradeR) : null,
      redis: true,
    };
  } catch (err) {
    console.error("[gradeTelemetry] Failed to read grade stats:", err);
    return {
      ok: false,
      grades: {},
      rDistribution: {},
      redis: true,
      error: String(err),
    };
  }
}

/**
 * Get formatted summary of grade performance for logging/alerts
 */
export async function getGradeSummary(): Promise<string> {
  const data = await readGradeStats();
  if (!data.ok || !data.redis) {
    return "Grade stats unavailable (no Redis)";
  }

  const lines: string[] = ["=== Grade Performance ==="];
  const grades = data.grades as Record<string, any>;
  
  for (const gradeKey of ["A+", "A", "B", "C"]) {
    const g = grades[gradeKey];
    if (!g || g.total === 0) continue;
    
    lines.push(
      `${gradeKey}: ${g.total} trades | WR: ${(g.winRate * 100).toFixed(1)}% | ` +
      `Avg R: ${g.avgR.toFixed(2)} | Runners: ${(g.runnerRate * 100).toFixed(1)}%`
    );
  }

  if (lines.length === 1) {
    return "No grade stats yet";
  }

  return lines.join("\n");
}
