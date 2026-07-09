/**
 * Agent KPI Model v2 — Trading Performance Focus
 *
 * Each agent carries three core KPI categories:
 *   1. Functional KPI — core job responsibilities
 *   2. Trading KPI — impact on avg R, win rate, execution
 *   3. Penalty KPI — degradation, safety violations, regressions
 *
 * Scoring:
 *   functional  = 25% weight
 *   trading     = 60% weight (biased heavily toward trading outcomes)
 *   penalty     = 15% weight (safety net)
 *
 * Total score = functional * 0.25 + trading * 0.60 - penalty * 0.15
 *
 * TARGET: System optimizes for trading performance, not build passes.
 */

// ─── Types ────────────────────────────────────────────────────────────────

export interface AgentKpiSummary {
  // Core scoring dimensions
  functionalScore: number; // 0–10, agent's core responsibilities
  tradingScore: number; // 0–10, impact on R, win rate, execution
  penaltyScore: number; // 0–10, degradation/violations

  // Weighted total (trading-first)
  totalScore: number; // 0–10, final composite

  // Trading performance metrics
  avgR?: number; // realized R average
  realizedR?: number; // recent realized R value
  winRate?: number; // % of closed trades with positive R
  executionRate?: number; // qualified → executed %
  latencySec?: number; // trade execution time (max acceptable: 60s)
  staleSignalPct?: number; // % of signals > 10min old
  seededToExecutedPct?: number; // qualified + seeded → executed

  // Engagement / reliability
  taskCompletionRate?: number; // % of assigned tasks completed
  incidentResponseTime?: number; // minutes to acknowledge critical issue
  regressionsDetected?: number; // count of unintended degradations

  // Context
  agentName?: string;
  asOf?: string;
  notes?: string[];
}

export interface PerformanceKpiThreshold {
  criticalBelowR?: number; // R performance critical threshold
  executionTargetPct?: number;
  latencyThresholdSec?: number;
  staleSignalThreshold?: number;
  seededToExecutedThreshold?: number;
}

// ─── Scoring Dimensions ───────────────────────────────────────────────────────

export interface TaskKpiImpact {
  /** Estimated R change from this task (-2 to +2) */
  expectedRImpact: "negative" | "neutral" | "positive" | "unknown";
  estimatedRDelta?: string; // "+0.5R to +2R/day"

  /** Actual measured R change post-completion */
  actualRImpact?: "negative" | "neutral" | "positive" | "unknown";
  actualRDelta?: string;

  /** Before/after metrics for evidence */
  beforeMetrics?: Record<string, number>;
  afterMetrics?: Record<string, number>;

  /** Task completion quality */
  completionStatus?: "SUCCESS" | "PARTIAL_SUCCESS" | "NO_IMPACT" | "REGRESSION";
}

// ─── Default KPI Thresholds ───────────────────────────────────────────────────

export const DEFAULT_KPI_THRESHOLDS: PerformanceKpiThreshold = {
  criticalBelowR: -0.5, // avg R below -0.5 triggers alerts
  executionTargetPct: 60, // target: 60%+ qualified → executed
  latencyThresholdSec: 300, // > 300s is CRITICAL
  staleSignalThreshold: 50, // > 50% stale signals is critical
  seededToExecutedThreshold: 40, // < 40% is critical
};

// ─── Scoring Helpers ──────────────────────────────────────────────────────────

/**
 * Calculate agent total score from three dimensions.
 *
 * Biases heavily toward trading performance (60% weight).
 * Functional correctness is secondary (25%).
 * Penalties reduce the total (15%).
 *
 * Example:
 *   functionalScore = 8 (good engineering)
 *   tradingScore = 6 (avg R weak)
 *   penaltyScore = 2 (one minor issue)
 *   => total = 8*0.25 + 6*0.60 - 2*0.15 = 2 + 3.6 - 0.3 = 5.3
 */
export function calculateAgentScore(
  summary: AgentKpiSummary,
): number {
  // Ensure scores are in valid range
  const fs = Math.max(0, Math.min(10, summary.functionalScore));
  const ts = Math.max(0, Math.min(10, summary.tradingScore));
  const ps = Math.max(0, Math.min(10, summary.penaltyScore));

  // Weighted calculation, biased toward trading
  const total = fs * 0.25 + ts * 0.6 - ps * 0.15;

  return Math.max(0, Math.min(10, total));
}

/**
 * Classify agent performance into bands.
 */
export function classifyAgentPerformance(
  score: number,
): "EXCELLENT" | "GOOD" | "ACCEPTABLE" | "NEEDS_ATTENTION" | "CRITICAL" {
  if (score >= 8.5) return "EXCELLENT";
  if (score >= 7) return "GOOD";
  if (score >= 5.5) return "ACCEPTABLE";
  if (score >= 3.5) return "NEEDS_ATTENTION";
  return "CRITICAL";
}

/**
 * Extract KPI summary from combined data sources.
 *
 * Aggregates metrics from:
 *   - performance analytics (avg R, win rate)
 *   - execution funnel (execution rate, latency)
 *   - signal freshness (stale %)
 *   - task completion (task stats)
 */
export function computeAgentKpiSummary(
  agentName: string,
  trainingMetrics: {
    avgR?: number;
    winRate?: number;
    executionRate?: number;
    latencySec?: number;
    staleSignalPct?: number;
    seededToExecutedPct?: number;
  },
  functionalMetrics: {
    taskCompletionRate?: number;
    incidentResponseTime?: number;
    regressionsDetected?: number;
  },
  thresholds = DEFAULT_KPI_THRESHOLDS,
): AgentKpiSummary {
  const { avgR, winRate, executionRate, latencySec, staleSignalPct, seededToExecutedPct } =
    trainingMetrics;

  // Calculate functional score: task completion, responsiveness
  let functionalScore = 5;
  if (functionalMetrics.taskCompletionRate !== undefined) {
    functionalScore = (functionalMetrics.taskCompletionRate * 100) / 12.5; // scale 0–100% to 0–10
  }
  if (functionalMetrics.incidentResponseTime !== undefined) {
    // Bonus for fast response < 5min
    if (functionalMetrics.incidentResponseTime < 5) functionalScore += 1.5;
    else if (functionalMetrics.incidentResponseTime > 30) functionalScore -= 1;
  }

  // Calculate trading score: avg R, win rate, execution
  let tradingScore = 5;
  if (avgR !== undefined) {
    // Map realized R (-2 to +2) to score (0-10)
    tradingScore = Math.max(0, Math.min(10, 5 + avgR * 2.5));
  }
  if (winRate !== undefined) {
    // Weight win rate heavily
    tradingScore = Math.max(tradingScore, (winRate * 100) / 12.5);
  }
  if (executionRate !== undefined) {
    // Execution rate impact
    tradingScore = (tradingScore + (executionRate * 100) / 12.5) / 2;
  }

  // Calculate penalty score: stale signals, latency, missed executions
  let penaltyScore = 0;
  if (staleSignalPct !== undefined && staleSignalPct > (thresholds.staleSignalThreshold || 50)) {
    penaltyScore += 3; // -30bps equivalent
  }
  if (latencySec !== undefined && latencySec > (thresholds.latencyThresholdSec || 300)) {
    penaltyScore += 2;
  }
  if (
    seededToExecutedPct !== undefined &&
    seededToExecutedPct < (thresholds.seededToExecutedThreshold || 40)
  ) {
    penaltyScore += 3;
  }
  if (functionalMetrics.regressionsDetected && functionalMetrics.regressionsDetected > 0) {
    penaltyScore += functionalMetrics.regressionsDetected * 2;
  }

  const totalScore = calculateAgentScore({
    functionalScore: Math.max(0, Math.min(10, functionalScore)),
    tradingScore: Math.max(0, Math.min(10, tradingScore)),
    penaltyScore: Math.max(0, Math.min(10, penaltyScore)),
    totalScore: 0, // will be computed
    avgR,
    realizedR: avgR,
    winRate,
    executionRate,
    latencySec,
    staleSignalPct,
    seededToExecutedPct,
  });

  return {
    functionalScore: Math.max(0, Math.min(10, functionalScore)),
    tradingScore: Math.max(0, Math.min(10, tradingScore)),
    penaltyScore: Math.max(0, Math.min(10, penaltyScore)),
    totalScore,
    avgR,
    realizedR: avgR,
    winRate,
    executionRate,
    latencySec,
    staleSignalPct,
    seededToExecutedPct,
    agentName,
    asOf: new Date().toISOString(),
    notes: [],
  };
}

/**
 * Summarize KPI health across all agents.
 */
export function summarizeAgentKpiHealth(
  summaries: AgentKpiSummary[],
): {
  overallScore: number;
  avgTradingScore: number;
  avgFunctionalScore: number;
  agentsByPerformance: Array<{
    agentName?: string;
    score: number;
    status: string;
  }>;
} {
  const scores = summaries.map((s) => s.totalScore);
  const tradingScores = summaries.map((s) => s.tradingScore).filter((s) => s !== undefined) as number[];
  const functionalScores = summaries.map((s) => s.functionalScore);

  const overallScore =
    scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

  const avgTradingScore = tradingScores.length > 0 ? tradingScores.reduce((a, b) => a + b, 0) / tradingScores.length : 0;
  const avgFunctionalScore = functionalScores.reduce((a, b) => a + b, 0) / functionalScores.length || 0;

  return {
    overallScore,
    avgTradingScore,
    avgFunctionalScore,
    agentsByPerformance: summaries
      .map((s) => ({
        agentName: s.agentName,
        score: s.totalScore,
        status: classifyAgentPerformance(s.totalScore),
      }))
      .sort((a, b) => b.score - a.score),
  };
}

/**
 * Flag critical KPI violations that need immediate attention.
 */
export function identifyKpiCriticals(
  summary: AgentKpiSummary,
  thresholds = DEFAULT_KPI_THRESHOLDS,
): string[] {
  const criticals: string[] = [];

  if (
    summary.avgR !== undefined &&
    thresholds.criticalBelowR !== undefined &&
    summary.avgR < thresholds.criticalBelowR
  ) {
    criticals.push(`avgR critical: ${summary.avgR.toFixed(2)} < ${thresholds.criticalBelowR}`);
  }

  if (
    summary.latencySec !== undefined &&
    thresholds.latencyThresholdSec !== undefined &&
    summary.latencySec > thresholds.latencyThresholdSec
  ) {
    criticals.push(`latency critical: ${summary.latencySec}s > ${thresholds.latencyThresholdSec}s`);
  }

  if (
    summary.staleSignalPct !== undefined &&
    thresholds.staleSignalThreshold !== undefined &&
    summary.staleSignalPct > thresholds.staleSignalThreshold
  ) {
    criticals.push(
      `stale signals critical: ${summary.staleSignalPct.toFixed(0)}% > ${thresholds.staleSignalThreshold}%`,
    );
  }

  if (
    summary.seededToExecutedPct !== undefined &&
    thresholds.seededToExecutedThreshold !== undefined &&
    summary.seededToExecutedPct < thresholds.seededToExecutedThreshold
  ) {
    criticals.push(
      `execution rate critical: ${summary.seededToExecutedPct.toFixed(0)}% < ${thresholds.seededToExecutedThreshold}%`,
    );
  }

  if (summary.totalScore < 3.5) {
    criticals.push(`overall KPI score critical: ${summary.totalScore.toFixed(1)} < 3.5`);
  }

  return criticals;
}
