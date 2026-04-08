/**
 * Execution Impact Tracking — Phase 3
 *
 * Persists before/after trading metric snapshots for agent executions so that
 * the system can learn whether engineering changes improved trading outcomes.
 */

import { redis } from "@/lib/redis";
import { getTtlSeconds, setWithTtl } from "@/lib/redis/ttl";
import { readTrades } from "@/lib/tradesStore";
import { extractClosedTrades } from "@/lib/performance/tradeStats";
import { nowIso } from "@/lib/agents/time";
import { AGENT_EXECUTION_IMPACT_KEY } from "@/lib/agents/keys";
import type {
  AgentName,
  ExecutionImpactRecord,
  ImpactStatus,
  TradingMetricsSnapshot,
} from "@/lib/agents/types";

const STORE_TTL = getTtlSeconds("TELEMETRY_DAYS");
const HISTORY_LIMIT = 100;
const DEEP_LOSS_R = -1.5;
const RECENT_DAYS = 14;

function ageFilter(ts: string | undefined, days: number): boolean {
  if (!ts) return false;
  const ms = Date.now() - new Date(ts).getTime();
  return ms <= days * 24 * 60 * 60 * 1000;
}

function safeRate(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 1000;
}
function safeAvg(sum: number, count: number): number {
  return count === 0 ? 0 : Math.round((sum / count) * 1000) / 1000;
}

// ─── Metric capture ───────────────────────────────────────────────────────────

export async function captureMetricsSnapshot(): Promise<TradingMetricsSnapshot> {
  const now = nowIso();
  const all = await readTrades().catch(() => []);
  const closed = extractClosedTrades(Array.isArray(all) ? all : []).filter((t) =>
    ageFilter(t.closedAt || t.updatedAt || t.createdAt, RECENT_DAYS),
  );

  const total = closed.length;
  let wins = 0;
  let rSum = 0;
  let deepLoss = 0;
  let longWins = 0;
  let longCount = 0;
  let shortWins = 0;
  let shortCount = 0;
  let scoredCount = 0;
  let scoreSum = 0;

  for (const t of closed) {
    const pnl = t.realizedPnL ?? 0;
    const r = t.realizedR ?? 0;
    rSum += r;
    if (pnl > 0) wins += 1;
    if (r <= DEEP_LOSS_R) deepLoss += 1;

    const side = String(t.side ?? "").toUpperCase();
    if (side === "BUY" || side === "LONG") {
      longCount += 1;
      if (pnl > 0) longWins += 1;
    } else if (side === "SELL" || side === "SHORT") {
      shortCount += 1;
      if (pnl > 0) shortWins += 1;
    }

    if (t.score != null && Number.isFinite(t.score)) {
      scoredCount += 1;
      scoreSum += t.score;
    }
  }

  // "Protected" = trade had a stop set (approximated from stopPrice presence)
  const protectedCount = closed.filter((t) => t.stopPrice != null && t.stopPrice > 0).length;

  // "Qualified" = tier A or B (approximated)
  const qualifiedCount = closed.filter((t) => t.tier === "A" || t.tier === "B").length;

  return {
    qualificationRate: safeRate(qualifiedCount, total),
    avgAiScore: safeAvg(scoreSum, scoredCount),
    scoredCount,
    qualifiedCount,
    winRate: safeRate(wins, total),
    avgR: safeAvg(rSum, total),
    totalTrades: total,
    protectedTradeRate: safeRate(protectedCount, total),
    deepLossRate: safeRate(deepLoss, total),
    longWinRate: safeRate(longWins, longCount),
    shortWinRate: safeRate(shortWins, shortCount),
    capturedAt: now,
  };
}

// ─── Impact scoring ───────────────────────────────────────────────────────────

function computeImpactScore(
  baseline: TradingMetricsSnapshot | null,
  post: TradingMetricsSnapshot | null,
): { score: number | null; status: ImpactStatus } {
  if (!baseline || !post) return { score: null, status: "INCONCLUSIVE" };

  // Weight the most important deltas
  const winRateDelta = (post.winRate - baseline.winRate) * 40;
  const avgRDelta = (post.avgR - baseline.avgR) * 30;
  const deepLossDelta = (baseline.deepLossRate - post.deepLossRate) * 20; // positive if improved
  const qualDelta = (post.qualificationRate - baseline.qualificationRate) * 10;

  const score = Math.round(winRateDelta + avgRDelta + deepLossDelta + qualDelta);

  let status: ImpactStatus;
  if (post.totalTrades - baseline.totalTrades < 2) {
    status = "INCONCLUSIVE"; // not enough new trade data yet
  } else if (score >= 3) {
    status = "IMPROVED";
  } else if (score <= -3) {
    status = "DEGRADED";
  } else {
    status = "NEUTRAL";
  }

  return { score, status };
}

// ─── Persistence ─────────────────────────────────────────────────────────────

async function readImpactHistory(): Promise<ExecutionImpactRecord[]> {
  if (!redis) return [];
  try {
    const raw = await redis.get<string>(AGENT_EXECUTION_IMPACT_KEY);
    if (!raw) return [];
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed as ExecutionImpactRecord[];
  } catch {
    return [];
  }
}

async function writeImpactHistory(records: ExecutionImpactRecord[]): Promise<void> {
  if (!redis) return;
  try {
    await setWithTtl(
      redis,
      AGENT_EXECUTION_IMPACT_KEY,
      JSON.stringify(records.slice(0, HISTORY_LIMIT)),
      STORE_TTL,
    );
  } catch {
    // non-fatal
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Open an impact envelope before execution. Call this to capture the baseline.
 */
export async function openImpactEnvelope(
  taskId: string,
  agent: AgentName,
): Promise<{ envelopeId: string; baseline: TradingMetricsSnapshot }> {
  const baseline = await captureMetricsSnapshot();
  const envelopeId = crypto.randomUUID();

  const record: ExecutionImpactRecord = {
    id: crypto.randomUUID(),
    executionId: envelopeId,
    taskId,
    agent,
    commitSha: null,
    baselineMetrics: baseline,
    postMetrics: null,
    executionImpactScore: null,
    impactStatus: "INCONCLUSIVE",
    notes: "Baseline captured. Awaiting post-execution metrics.",
    createdAt: nowIso(),
    resolvedAt: null,
  };

  const history = await readImpactHistory();
  await writeImpactHistory([record, ...history]);

  return { envelopeId, baseline };
}

/**
 * Close an impact envelope after execution. Resolves the impact status.
 */
export async function closeImpactEnvelope(
  envelopeId: string,
  commitSha: string | null,
): Promise<ExecutionImpactRecord | null> {
  const history = await readImpactHistory();
  const idx = history.findIndex((r) => r.executionId === envelopeId);
  if (idx === -1) return null;

  const record = history[idx];
  const post = await captureMetricsSnapshot();
  const { score, status } = computeImpactScore(record.baselineMetrics, post);

  const updated: ExecutionImpactRecord = {
    ...record,
    commitSha,
    postMetrics: post,
    executionImpactScore: score,
    impactStatus: status,
    notes: `Impact: ${status}. Score delta: ${score ?? "n/a"}.`,
    resolvedAt: nowIso(),
  };

  history[idx] = updated;
  await writeImpactHistory(history);
  return updated;
}

export async function listImpactRecords(limit = 50): Promise<ExecutionImpactRecord[]> {
  const history = await readImpactHistory();
  return history.slice(0, limit);
}
