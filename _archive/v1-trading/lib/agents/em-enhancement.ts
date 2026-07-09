/**
 * Engineering Manager Enhancement — Performance-First Operating Model v2
 *
 * Enhances the existing Engineering Manager with:
 *   1. Work freeze detection when funnel degrades
 *   2. Priority ranking by trading impact (via priority-engine)
 *   3. Enforcement of allowed work types during freeze
 *   4. R-impact-driven task selection
 *   5. KPI monitoring and health checks
 *
 * Called by EM orchestration to filter and rank tasks before selection.
 */

import type { EngineeringTask, BacklogItem } from "@/lib/agents/types";
import type { SharedTradingKpis } from "@/lib/agents/trading-kpis";
import { getSharedTradingKpis, calculateFreezeConditions } from "@/lib/agents/trading-kpis";
import { rankTasks, selectNextTask, filterByWorkType, summarizeTaskDistribution, type PriorityScore } from "@/lib/agents/priority-engine";
import { redis } from "@/lib/redis";
import { nowIso } from "@/lib/agents/time";

// ─── EM Extension State ────────────────────────────────────────────────────────

export interface WorkFreezeState {
  isFrozen: boolean;
  reasons: string[];
  allowedWorkTypes: string[];
  frozenAt: string;
  unfreezeEstimate?: string;
}

export interface EmEnhancedBrief {
  asOf: string;
  freezeState: WorkFreezeState;
  rankedTasks: PriorityScore[];
  taskDistribution: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    frozen: number;
  };
  nextExecutableTask: PriorityScore | null;
  tradingKpis: SharedTradingKpis;
  kpiHealth: string;
  blockedTasksCount: number;
  frozenTasksCount: number;
  recommendations: string[];
}

// ─── Storage Keys ──────────────────────────────────────────────────────────────

const WORK_FREEZE_STATE_KEY = "em:work-freeze-state";
const ENHANCED_BRIEF_KEY = "em:enhanced-brief";

// ─── Work Freeze Management ────────────────────────────────────────────────────

/**
 * Compute current work freeze state from trading KPIs.
 */
export function computeWorkFreezeState(
  tradingKpis: SharedTradingKpis,
): WorkFreezeState {
  const { shouldFreeze, reasons, allowedWorkTypes } = calculateFreezeConditions(tradingKpis);

  const state: WorkFreezeState = {
    isFrozen: shouldFreeze,
    reasons,
    allowedWorkTypes,
    frozenAt: shouldFreeze ? nowIso() : "",
  };

  // Estimate unfreeze time based on reasons
  if (shouldFreeze) {
    // Optimistic: 30 min per critical issue
    const estimatedMinutes = Math.min(120, reasons.length * 30);
    state.unfreezeEstimate = new Date(Date.now() + estimatedMinutes * 60 * 1000).toISOString();
  }

  return state;
}

/**
 * Persist work freeze state to Redis.
 */
export async function writeWorkFreezeState(state: WorkFreezeState): Promise<void> {
  if (!redis) return;

  try {
    await redis.set(WORK_FREEZE_STATE_KEY, JSON.stringify(state));
    await redis.expire(WORK_FREEZE_STATE_KEY, 3600); // 1h TTL
  } catch {
    // non-fatal
  }
}

/**
 * Read persisted work freeze state.
 */
export async function readWorkFreezeState(): Promise<WorkFreezeState | null> {
  if (!redis) return null;

  try {
    const raw = await redis.get<string>(WORK_FREEZE_STATE_KEY);
    if (!raw) return null;

    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === "object" && "isFrozen" in parsed) {
      return parsed as WorkFreezeState;
    }

    return null;
  } catch {
    return null;
  }
}

// ─── KPI Health Checks ─────────────────────────────────────────────────────────

/**
 * Summarize trading KPI health for EM decisions.
 */
function summarizeKpiHealth(tradingKpis: SharedTradingKpis): string {
  const parts: string[] = [];

  if (tradingKpis.avgRealizedR < -0.5) {
    parts.push(`🔴 avgR CRITICAL: ${tradingKpis.avgRealizedR.toFixed(2)}`);
  } else if (tradingKpis.avgRealizedR < 0) {
    parts.push(`🟠 avgR warning: ${tradingKpis.avgRealizedR.toFixed(2)}`);
  } else {
    parts.push(`✅ avgR healthy: ${tradingKpis.avgRealizedR.toFixed(2)}`);
  }

  if (tradingKpis.executionLatencySec > 300) {
    parts.push(`🔴 latency CRITICAL: ${tradingKpis.executionLatencySec.toFixed(0)}s`);
  }

  if (tradingKpis.freshSignalPct < 50) {
    parts.push(`🔴 freshness CRITICAL: ${tradingKpis.freshSignalPct.toFixed(0)}%`);
  }

  if (tradingKpis.seededToExecutedPct < 40) {
    parts.push(`🔴 execution CRITICAL: ${tradingKpis.seededToExecutedPct.toFixed(0)}%`);
  }

  return parts.join(" | ");
}

/**
 * Generate recommendations for EM based on KPI violations.
 */
function generateRecommendations(
  tradingKpis: SharedTradingKpis,
  freezeState: WorkFreezeState,
): string[] {
  const recommendations: string[] = [];

  if (freezeState.isFrozen) {
    recommendations.push(`🔴 Work freeze active: ${freezeState.reasons[0]} — focus on EXECUTION, RISK, PERFORMANCE tasks only`);

    if (tradingKpis.executionLatencySec > 300) {
      recommendations.push(`Priority 1: Reduce execution latency from ${tradingKpis.executionLatencySec.toFixed(0)}s to < 60s`);
    }

    if (tradingKpis.freshSignalPct < 50) {
      recommendations.push(`Priority 2: Improve fresh signal % from ${tradingKpis.freshSignalPct.toFixed(0)}% to > 70%`);
    }

    if (tradingKpis.seededToExecutedPct < 40) {
      recommendations.push(`Priority 3: Fix execution conversion from ${tradingKpis.seededToExecutedPct.toFixed(0)}% to > 60%`);
    }
  } else {
    recommendations.push(`✅ Normal operations: All work types permitted`);

    if (tradingKpis.avgRealizedR < 0.5) {
      recommendations.push(`Consider: avgR is ${tradingKpis.avgRealizedR.toFixed(2)} — focus on profit integrity`);
    }

    if (tradingKpis.drawdown < -3) {
      recommendations.push(`Monitor: Drawdown at ${tradingKpis.drawdown.toFixed(2)}R — ensure stop protection`);
    }
  }

  return recommendations;
}

// ─── Task Filtering and Ranking ────────────────────────────────────────────────

/**
 * Filter and rank tasks considering work freeze and trading impact.
 */
export async function rankTasksByTradingImpact(
  tasks: Array<Partial<EngineeringTask> | Partial<BacklogItem>>,
): Promise<PriorityScore[]> {
  const tradingKpis = await getSharedTradingKpis();
  return rankTasks(tasks, tradingKpis);
}

/**
 * Select the next executable task considering freeze state.
 */
export async function selectNextExecutableTask(
  tasks: Array<Partial<EngineeringTask> | Partial<BacklogItem>>,
): Promise<PriorityScore | null> {
  const tradingKpis = await getSharedTradingKpis();
  return selectNextTask(tasks, tradingKpis);
}

/**
 * Enforce work freeze: filter tasks to only allowed types.
 */
export function enforceWorkFreeze(
  rankedTasks: PriorityScore[],
  freezeState: WorkFreezeState,
): PriorityScore[] {
  if (!freezeState.isFrozen) {
    return rankedTasks;
  }

  // Only return tasks in allowed work types
  const allowedTypes = freezeState.allowedWorkTypes as any[];
  return rankedTasks.filter((t) => allowedTypes.includes(t.category));
}

// ─── EM Orchestration Enhancement ──────────────────────────────────────────────

/**
 * Compute enhanced EM brief with work freeze and KPI awareness.
 *
 * Called after traditional EM orchestration to add:
 *   - Work freeze detection
 *   - Task ranking by trading impact
 *   - KPI health status
 *   - Recommendations
 */
export async function computeEnhancedEmBrief(
  allTasks: Array<Partial<EngineeringTask> | Partial<BacklogItem>>,
): Promise<EmEnhancedBrief> {
  // Fetch trading KPIs
  const tradingKpis = await getSharedTradingKpis();

  // Compute work freeze state
  const freezeState = computeWorkFreezeState(tradingKpis);

  // Rank tasks by trading impact
  const rankedTasks = rankTasks(allTasks, tradingKpis);

  // Enforce freeze: only return allowed work types if frozen
  const executableTasks = enforceWorkFreeze(rankedTasks, freezeState);

  // Select next executable task
  const nextExecutableTask = executableTasks[0] || null;

  // Compute task distribution
  const taskDist = summarizeTaskDistribution(rankedTasks);

  // Generate health and recommendations
  const kpiHealth = summarizeKpiHealth(tradingKpis);
  const recommendations = generateRecommendations(tradingKpis, freezeState);

  // Count blocked tasks
  const blockedTasks = rankedTasks.filter((t) => t.frozen);
  const frozenTasks = rankedTasks.filter(
    (t) => freezeState.isFrozen && !freezeState.allowedWorkTypes.includes(t.category),
  );

  const brief: EmEnhancedBrief = {
    asOf: nowIso(),
    freezeState,
    rankedTasks: rankedTasks.slice(0, 30),
    taskDistribution: taskDist,
    nextExecutableTask,
    tradingKpis,
    kpiHealth,
    blockedTasksCount: blockedTasks.length,
    frozenTasksCount: frozenTasks.length,
    recommendations,
  };

  // Persist to Redis
  await writeEnhancedEmBrief(brief);

  return brief;
}

/**
 * Write enhanced EM brief to Redis.
 */
export async function writeEnhancedEmBrief(brief: EmEnhancedBrief): Promise<void> {
  if (!redis) return;

  try {
    await redis.set(ENHANCED_BRIEF_KEY, JSON.stringify(brief));
    await redis.expire(ENHANCED_BRIEF_KEY, 3600); // 1h TTL
  } catch {
    // non-fatal
  }
}

/**
 * Read enhanced EM brief from Redis.
 */
export async function readEnhancedEmBrief(): Promise<EmEnhancedBrief | null> {
  if (!redis) return null;

  try {
    const raw = await redis.get<string>(ENHANCED_BRIEF_KEY);
    if (!raw) return null;

    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === "object" && "freezeState" in parsed) {
      return parsed as EmEnhancedBrief;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Print enhanced EM brief in human-readable format.
 */
export function formatEnhancedBrief(brief: EmEnhancedBrief): string {
  const lines: string[] = [
    "═══════════════════════════════════════════════════════════════",
    "ENGINEERING MANAGER ENHANCED BRIEF — Performance-First Model v2",
    "═══════════════════════════════════════════════════════════════",
    "",
    `📊 TRADING KPI HEALTH: ${brief.kpiHealth}`,
    "",
    `🔒 WORK FREEZE: ${brief.freezeState.isFrozen ? "ACTIVE" : "INACTIVE"}`,
  ];

  if (brief.freezeState.isFrozen) {
    lines.push(`   Reasons: ${brief.freezeState.reasons.join("; ")}`);
    lines.push(`   Allowed work: ${brief.freezeState.allowedWorkTypes.join(", ")}`);
    lines.push(`   Estimate unfreeze: ${brief.freezeState.unfreezeEstimate}`);
  }

  lines.push("");
  lines.push(`📋 TASK DISTRIBUTION (${brief.rankedTasks.length} tasks):`);
  lines.push(`   🔴 Critical: ${brief.taskDistribution.critical}`);
  lines.push(`   🟠 High: ${brief.taskDistribution.high}`);
  lines.push(`   🟡 Medium: ${brief.taskDistribution.medium}`);
  lines.push(`   🟢 Low: ${brief.taskDistribution.low}`);
  lines.push(`   ⛔ Frozen: ${brief.taskDistribution.frozen}`);

  if (brief.nextExecutableTask) {
    lines.push("");
    lines.push(`▶️  NEXT EXECUTABLE TASK:`);
    lines.push(`   Category: ${brief.nextExecutableTask.category}`);
    lines.push(`   Title: ${brief.nextExecutableTask.title}`);
    lines.push(`   Score: ${brief.nextExecutableTask.score.toFixed(1)}/100`);
    lines.push(`   Rationale: ${brief.nextExecutableTask.rationale.slice(0, 80)}...`);
  }

  lines.push("");
  lines.push(`💡 RECOMMENDATIONS:`);
  for (const rec of brief.recommendations) {
    lines.push(`   ${rec}`);
  }

  lines.push("");
  lines.push(`⏱️  Last updated: ${brief.asOf}`);
  lines.push("═══════════════════════════════════════════════════════════════");

  return lines.join("\n");
}
