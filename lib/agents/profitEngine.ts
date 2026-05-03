/**
 * Profit Optimization Engine
 *
 * Detects real trading performance patterns, generates targeted safe improvement
 * tasks, and runs experiment lifecycle management.
 *
 * Priority:
 *   1. Funnel health check — if seeded=0, force fix tasks first. Engine stops.
 *   2. Performance pattern detection from closed trades.
 *   3. Safe task generation (scoring/scanning/seeding only — never order logic).
 *   4. Experiment feedback: close ACTIVE experiments and revert on degradation.
 *
 * Safe modification targets (ALLOWED):
 *   - lib/aiScoring.ts, lib/aiQualify.ts         (scoring thresholds/filters)
 *   - lib/scanner/*.ts, lib/scannerUtils.ts       (volume/relVol/VWAP thresholds)
 *   - lib/autoEntry/seed*.ts                      (freshness window, minScore)
 *   - lib/funnelMetrics.ts, lib/funnelRedis.ts    (funnel telemetry)
 *   - app/api/performance/*, app/api/funnel-health (diagnostics)
 *
 * DO NOT target (BLOCKED):
 *   - app/api/auto-entry/execute       (order execution)
 *   - lib/broker/*, lib/alpaca*        (broker integration)
 *   - lib/risk/protection*             (stop logic)
 *   - lib/tradeEngine.ts               (trade engine)
 */

import { redis } from "@/lib/redis";
import { getTtlSeconds } from "@/lib/redis/ttl";
import { AGENT_PROFIT_ENGINE_KEY } from "@/lib/agents/keys";
import { readPerformanceLearning, computePerformanceLearning } from "@/lib/agents/performanceLearning";
import { appendEngineeringTask } from "@/lib/agents/store";
import { isRecentDuplicateTask } from "@/lib/agents/task-dedup";
import { nowIso } from "@/lib/agents/time";
import {
  openExperiment,
  closeExperiment,
  getActiveExperiments,
  markExperimentReverted,
  type ExperimentMetrics,
} from "@/lib/agents/experimentTracker";
import { readTrades } from "@/lib/tradesStore";
import { extractClosedTrades, buildAnalytics } from "@/lib/performance/tradeStats";
import type { EngineeringTask } from "@/lib/agents/types";

const STORE_TTL = getTtlSeconds("TELEMETRY_DAYS");
const MIN_TRADES_FOR_PATTERNS = 5;
const PROFIT_ENGINE_EVAL_INTERVAL_MS = 15 * 60 * 1000; // 15 min between full evaluations

// ─── Types ───────────────────────────────────────────────────────────

export interface ProfitEngineState {
  lastRunAt: string | null;
  lastOptimizationType: string | null;
  lastOptimizationAt: string | null;
  lastWinRate: number | null;
  lastAvgR: number | null;
  lastTradeCount: number | null;
  funnelBlocked: boolean;
  funnelBlockedReason: string | null;
  engineActive: boolean;
  tasksCreatedThisRun: string[];
  experimentsOpenedThisRun: string[];
  optimizationImpact: OptimizationImpact | null;
  evaluationLog: string[];
}

export interface OptimizationImpact {
  experimentId: string;
  optimizationType: string;
  deltaWinRate: number | null;
  deltaR: number | null;
  status: "IMPROVED" | "DEGRADED" | "NEUTRAL" | "INSUFFICIENT";
  revertRecommended: boolean;
  measuredAt: string;
}

export interface ProfitEngineResult {
  ran: boolean;
  funnelBlocked: boolean;
  funnelBlockedReason: string | null;
  patternsDetected: string[];
  tasksCreated: string[];
  experimentsOpened: string[];
  experimentsEvaluated: number;
  revertsRecommended: number;
  winRate: number | null;
  avgR: number | null;
  engineActive: boolean;
}

// ─── Funnel Health Check ─────────────────────────────────────────────

interface FunnelConversion {
  qualifiedToSeeded: number | null;
  seededToExecuted: number | null;
  seeded: number;
}

async function checkFunnelHealth(baseUrl: string): Promise<{
  blocked: boolean;
  reason: string | null;
  conversion: FunnelConversion | null;
}> {
  try {
    const res = await fetch(`${baseUrl}/api/funnel-health`, {
      headers: { "cache-control": "no-store" },
      signal: AbortSignal.timeout(8_000),
    }).catch(() => null);

    if (!res || !res.ok) return { blocked: false, reason: null, conversion: null };

    const data = await res.json().catch(() => null);
    if (!data) return { blocked: false, reason: null, conversion: null };

    const conv = data.funnel as { seeded?: number; qualified?: number; executed?: number } | undefined;
    const convRatio = data.conversion as {
      qualifiedToSeeded?: number | null;
      seededToExecuted?: number | null;
    } | undefined;

    const seeded = Number(conv?.seeded ?? 0);
    const qualified = Number(conv?.qualified ?? 0);

    const conversion: FunnelConversion = {
      qualifiedToSeeded: convRatio?.qualifiedToSeeded ?? null,
      seededToExecuted: convRatio?.seededToExecuted ?? null,
      seeded,
    };

    // Funnel is broken if market is active (has qualified signals) but seeded=0
    if (qualified > 0 && seeded === 0) {
      return {
        blocked: true,
        reason: `seeded=0 with qualified=${qualified} — funnel broken before profit engine can run`,
        conversion,
      };
    }

    return { blocked: false, reason: null, conversion };
  } catch {
    return { blocked: false, reason: null, conversion: null };
  }
}

// ─── Pattern Detection Logic ─────────────────────────────────────────

interface ProfitPattern {
  id: string;
  title: string;
  summary: string;
  optimizationType: string;
  likelyFiles: string[];
  urgency: "high" | "medium" | "low";
  priority: "HIGH" | "MEDIUM" | "LOW";
  smokeChecks: string[];
}

function detectProfitPatterns(params: {
  winRate: number;
  avgR: number;
  tradeCount: number;
  tierWinRates: Record<string, number>;
  tierAvgRs: Record<string, number>;
  tierTradeCounts: Record<string, number>;
  funnelConversion: FunnelConversion | null;
  weakSetupClasses: string[];
}): ProfitPattern[] {
  const {
    winRate,
    avgR,
    tradeCount,
    tierWinRates,
    tierAvgRs,
    tierTradeCounts,
    funnelConversion,
    weakSetupClasses,
  } = params;
  const patterns: ProfitPattern[] = [];

  // ── 1. Funnel conversion: qualifiedToSeeded = 0 ────────────────────────────
  if (
    funnelConversion &&
    funnelConversion.qualifiedToSeeded !== null &&
    funnelConversion.qualifiedToSeeded === 0
  ) {
    patterns.push({
      id: "qualified_to_seeded_zero",
      title: "[ProfitEngine] Fix: qualified signals not seeding",
      summary:
        "qualifiedToSeeded conversion rate is 0 — signals are qualifying but not being seeded. " +
        "Likely cause: freshness window too narrow, minScore gate, or duplicate-signal filter rejecting all candidates.",
      optimizationType: "seeding_fix",
      likelyFiles: [
        "lib/autoEntry/seed.ts",
        "lib/autoEntry/seedTelemetry.ts",
        "lib/funnelRedis.ts",
      ],
      urgency: "high",
      priority: "HIGH",
      smokeChecks: [
        "GET /api/funnel-health",
        "GET /api/auto-entry/summary",
        "GET /api/readiness",
      ],
    });
  }

  // ── 2. Funnel conversion: seededToExecuted = 0 ────────────────────────────
  if (
    funnelConversion &&
    funnelConversion.seededToExecuted !== null &&
    funnelConversion.seededToExecuted === 0 &&
    funnelConversion.seeded > 0
  ) {
    patterns.push({
      id: "seeded_to_executed_zero",
      title: "[ProfitEngine] Fix: seeded signals not executing",
      summary:
        "seededToExecuted conversion rate is 0 — signals are seeded but execution is gated. " +
        "Likely cause: guardrail override, capacity full, scoring gate, or scoring threshold too high.",
      optimizationType: "execution_gating_fix",
      likelyFiles: [
        "lib/aiQualify.ts",
        "lib/autoEntry/guardrails.ts",
        "app/api/agents/state/route.ts",
      ],
      urgency: "high",
      priority: "HIGH",
      smokeChecks: [
        "GET /api/funnel-health",
        "GET /api/agents/state",
        "GET /api/auto-entry/summary",
      ],
    });
  }

  // ── 3. C-tier win rate < 35% with sufficient sample ────────────────────────
  const cWinRate = tierWinRates["C"] ?? 1;
  const cCount = tierTradeCounts["C"] ?? 0;
  if (cCount >= 5 && cWinRate < 0.35) {
    patterns.push({
      id: "tier_c_high_loss_rate",
      title: "[ProfitEngine] Tighten C-tier scoring filters",
      summary:
        `C-tier win rate ${(cWinRate * 100).toFixed(0)}% < 35% over ${cCount} trades. ` +
        "Add diagnostics and tighten C-tier minimum score threshold to reduce low-quality entries.",
      optimizationType: "scoring_c_tier_tighten",
      likelyFiles: [
        "lib/aiScoring.ts",
        "lib/aiQualify.ts",
        "app/api/performance/analytics/route.ts",
        "app/api/funnel-health/route.ts",
      ],
      urgency: cWinRate < 0.25 ? "high" : "medium",
      priority: cWinRate < 0.25 ? "HIGH" : "MEDIUM",
      smokeChecks: [
        "GET /api/performance/analytics",
        "GET /api/funnel-health",
        "GET /api/readiness",
      ],
    });
  }

  // ── 4. Negative overall avgR ──────────────────────────────────────────────
  if (avgR < 0 && tradeCount >= MIN_TRADES_FOR_PATTERNS) {
    patterns.push({
      id: "negative_avg_r",
      title: "[ProfitEngine] Optimize exit strategy — negative avgR",
      summary:
        `Average R across ${tradeCount} trades is ${avgR.toFixed(3)}. ` +
        "Add exit quality diagnostics to performance scorecard and identify R-drag patterns.",
      optimizationType: "exit_optimization",
      likelyFiles: [
        "app/api/performance/analytics/route.ts",
        "app/api/performance/scorecard/route.ts",
        "lib/agents/performanceLearning.ts",
      ],
      urgency: avgR < -0.5 ? "high" : "medium",
      priority: avgR < -0.5 ? "HIGH" : "MEDIUM",
      smokeChecks: [
        "GET /api/performance/analytics",
        "GET /api/performance/scorecard",
        "GET /api/readiness",
      ],
    });
  }

  // ── 5. Weak setup classes from learning signals ───────────────────────────
  for (const weakClass of weakSetupClasses) {
    if (weakClass === "tier_C_high_loss_rate") continue; // already handled above
    if (weakClass.includes("short_side")) {
      patterns.push({
        id: `weak_class_${weakClass}`,
        title: `[ProfitEngine] Improve short-side filtering (${weakClass})`,
        summary:
          `Weak setup class detected: ${weakClass}. ` +
          "Review short qualification: relVol minimum, VWAP distance, score threshold for shorts.",
        optimizationType: `filter_${weakClass}`,
        likelyFiles: [
          "lib/aiScoring.ts",
          "lib/aiQualify.ts",
          "lib/scannerUtils.ts",
        ],
        urgency: "medium",
        priority: "MEDIUM",
        smokeChecks: [
          "GET /api/performance/analytics",
          "GET /api/funnel-health",
        ],
      });
    }
  }

  return patterns;
}

// ─── Task Generation ─────────────────────────────────────────────────

async function createOptimizationTask(
  pattern: ProfitPattern,
): Promise<EngineeringTask> {
  const task: EngineeringTask = {
    id: `profit-${pattern.id}-${Date.now().toString(36)}`,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: "OPEN",
    title: pattern.title,
    summary: pattern.summary,
    likelyFiles: pattern.likelyFiles,
    copilotPrompt:
      `Performance optimization task (${pattern.optimizationType}). ` +
      `Target files: ${pattern.likelyFiles.join(", ")}. ` +
      `Add diagnostics, metrics, and safe threshold adjustments only. ` +
      `DO NOT modify order execution, stop logic, or broker integration.`,
    smokeTestBlock: pattern.smokeChecks.join("\n"),
    gitBlock: `agent: ${pattern.title}`,
    incidentCategory: "SCORING",
    likelyRootCause: pattern.summary,
    recommendedNextAction: `Apply safe optimization: ${pattern.optimizationType}`,
    successCriteria: `${pattern.optimizationType} applied without degradation`,
    patchPlan: {
      mode: "GITHUB_COMMIT",
      targetFiles: pattern.likelyFiles,
      proposedChangesSummary: pattern.summary,
    },
    commitPlan: {
      commitMessage: `agent: ${pattern.title} [optimizationType:${pattern.optimizationType}]`,
      targetBranch: "main",
      pushDirect: true,
    },
    validationPlan: {
      buildRequired: true,
      testCommands: ["npm run test"],
      smokeChecks: pattern.smokeChecks,
    },
  };
  return appendEngineeringTask(task);
}

// ─── Funnel Force-Fix Tasks ───────────────────────────────────────────

async function createFunnelFixTasks(
  reason: string,
  conversion: FunnelConversion | null,
): Promise<string[]> {
  const taskIds: string[] = [];
  const fixes: Array<{ title: string; summary: string; files: string[] }> = [];

  if (conversion?.qualifiedToSeeded === 0) {
    fixes.push({
      title: "[ProfitEngine][CRITICAL] Fix: qualified signals not seeding",
      summary:
        `qualifiedToSeeded=0. Funnel broken: ${reason}. ` +
        "Investigate freshness window (freshMs), minScore gate on seed route, and duplicate-signal deduplication.",
      files: [
        "lib/autoEntry/seed.ts",
        "lib/autoEntry/seedTelemetry.ts",
        "lib/funnelRedis.ts",
        "lib/signals/since.ts",
      ],
    });
    fixes.push({
      title: "[ProfitEngine] Add freshness-window diagnostic to funnel-health",
      summary:
        "Add staleness breakdown to /api/funnel-health: freshMs threshold used, count of signals rejected for staleness.",
      files: [
        "app/api/funnel-health/route.ts",
        "lib/funnelMetrics.ts",
      ],
    });
  }

  for (const fix of fixes) {
    const isRecentDupe = await isRecentDuplicateTask(fix.title).catch(() => false);
    if (isRecentDupe) {
      console.log(`[PROFIT-ENGINE] Skipping duplicate funnel-fix task (24h window): ${fix.title}`);
      continue;
    }
    const task: EngineeringTask = {
      id: `profit-funnel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: "OPEN",
      title: fix.title,
      summary: fix.summary,
      likelyFiles: fix.files,
      copilotPrompt: `Funnel fix (CRITICAL priority): ${fix.summary}`,
      smokeTestBlock: "GET /api/funnel-health\nGET /api/auto-entry/summary\nGET /api/readiness",
      gitBlock: `agent: ${fix.title}`,
      incidentCategory: "FUNNEL_BLOCK",
      likelyRootCause: reason,
      recommendedNextAction: "Fix funnel before any profit optimization",
      patchPlan: {
        mode: "GITHUB_COMMIT",
        targetFiles: fix.files,
        proposedChangesSummary: fix.summary,
      },
      commitPlan: {
        commitMessage: `agent: ${fix.title}`,
        targetBranch: "main",
        pushDirect: true,
      },
      validationPlan: {
        buildRequired: true,
        testCommands: ["npm run test"],
        smokeChecks: ["GET /api/funnel-health", "GET /api/readiness"],
      },
    };
    const saved = await appendEngineeringTask(task).catch(() => null);
    if (saved) taskIds.push(saved.id);
  }

  return taskIds;
}

// ─── Experiment Feedback Loop ─────────────────────────────────────────

async function evaluateActiveExperiments(currentMetrics: ExperimentMetrics): Promise<{
  evaluated: number;
  revertsRecommended: number;
  impact: OptimizationImpact | null;
}> {
  const active = await getActiveExperiments();
  let revertsRecommended = 0;
  let latestImpact: OptimizationImpact | null = null;

  for (const exp of active) {
    // Only evaluate if enough trades have accumulated since the experiment opened
    const tradesSinceOpen = currentMetrics.tradeCount - exp.beforeMetrics.tradeCount;
    if (tradesSinceOpen < exp.minTradesForEval) continue;

    const { revertRecommended, experiment } = await closeExperiment({
      experimentId: exp.id,
      afterMetrics: currentMetrics,
    });

    if (revertRecommended) {
      revertsRecommended++;
      await markExperimentReverted(exp.id);
      console.log(
        `[PROFIT-ENGINE] Experiment ${exp.id} DEGRADED — revert recommended. ` +
          `ΔWinRate=${experiment?.deltaWinRate?.toFixed(3)} ΔR=${experiment?.deltaR?.toFixed(3)}`,
      );
    }

    if (experiment && (experiment.status === "IMPROVED" || experiment.status === "DEGRADED")) {
      latestImpact = {
        experimentId: experiment.id,
        optimizationType: experiment.optimizationType,
        deltaWinRate: experiment.deltaWinRate,
        deltaR: experiment.deltaR,
        status: experiment.status as "IMPROVED" | "DEGRADED",
        revertRecommended,
        measuredAt: nowIso(),
      };
    }
  }

  return { evaluated: active.length, revertsRecommended, impact: latestImpact };
}

// ─── Redis State ─────────────────────────────────────────────────────

async function readProfitEngineState(): Promise<ProfitEngineState> {
  const empty: ProfitEngineState = {
    lastRunAt: null,
    lastOptimizationType: null,
    lastOptimizationAt: null,
    lastWinRate: null,
    lastAvgR: null,
    lastTradeCount: null,
    funnelBlocked: false,
    funnelBlockedReason: null,
    engineActive: false,
    tasksCreatedThisRun: [],
    experimentsOpenedThisRun: [],
    optimizationImpact: null,
    evaluationLog: [],
  };
  if (!redis) return empty;
  try {
    const raw = await redis.get<string>(AGENT_PROFIT_ENGINE_KEY);
    if (!raw) return empty;
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === "object" && "lastRunAt" in parsed) {
      return parsed as ProfitEngineState;
    }
    return empty;
  } catch {
    return empty;
  }
}

async function writeProfitEngineState(state: ProfitEngineState): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(AGENT_PROFIT_ENGINE_KEY, JSON.stringify(state), { ex: STORE_TTL });
  } catch {
    // non-fatal
  }
}

export async function readProfitEngineStatus(): Promise<ProfitEngineState | null> {
  return readProfitEngineState();
}

// ─── Rate limiting ───────────────────────────────────────────────────

async function shouldRunEngine(state: ProfitEngineState): Promise<boolean> {
  if (!state.lastRunAt) return true;
  const lastRun = new Date(state.lastRunAt).getTime();
  return Date.now() - lastRun >= PROFIT_ENGINE_EVAL_INTERVAL_MS;
}

// ─── Deduplication helper ─────────────────────────────────────────────

async function patternAlreadyHasOpenTask(
  patternId: string,
  existingTasks: EngineeringTask[],
): Promise<boolean> {
  return existingTasks.some(
    (t) =>
      t.status === "OPEN" &&
      (t.id.includes(patternId) || t.title.includes(patternId) || t.summary?.includes(patternId)),
  );
}

// ─── Main Entry Point ────────────────────────────────────────────────

/**
 * Run the Profit Optimization Engine.
 * Should be called from the execute route (non-dryRun) alongside adaptive guardrails.
 *
 * @param baseUrl - base URL for internal API calls (e.g. funnel-health)
 * @param existingTasks - current open engineering tasks for deduplication
 */
export async function runProfitEngine(
  baseUrl: string,
  existingTasks: EngineeringTask[] = [],
): Promise<ProfitEngineResult> {
  const result: ProfitEngineResult = {
    ran: false,
    funnelBlocked: false,
    funnelBlockedReason: null,
    patternsDetected: [],
    tasksCreated: [],
    experimentsOpened: [],
    experimentsEvaluated: 0,
    revertsRecommended: 0,
    winRate: null,
    avgR: null,
    engineActive: false,
  };

  const state = await readProfitEngineState();

  // Rate-limit engine evaluations
  if (!(await shouldRunEngine(state))) {
    return result;
  }

  result.ran = true;
  result.engineActive = true;

  // ── Step 1: Funnel health gate ─────────────────────────────────────────────
  const funnelCheck = await checkFunnelHealth(baseUrl);
  if (funnelCheck.blocked) {
    result.funnelBlocked = true;
    result.funnelBlockedReason = funnelCheck.reason;

    // Create force-fix tasks for funnel before any profit optimization
    const fixTaskIds = await createFunnelFixTasks(
      funnelCheck.reason ?? "funnel_broken",
      funnelCheck.conversion,
    ).catch(() => []);
    result.tasksCreated.push(...fixTaskIds);

    // Persist and return — no profit optimization until funnel is fixed
    await writeProfitEngineState({
      ...state,
      lastRunAt: nowIso(),
      funnelBlocked: true,
      funnelBlockedReason: funnelCheck.reason,
      engineActive: false,
      tasksCreatedThisRun: fixTaskIds,
      experimentsOpenedThisRun: [],
      evaluationLog: [
        ...state.evaluationLog.slice(-10),
        `${nowIso()}: funnel_blocked — ${funnelCheck.reason}`,
      ],
    });

    console.log(`[PROFIT-ENGINE] Blocked by funnel: ${funnelCheck.reason}`);
    return result;
  }

  // ── Step 2: Compute performance signals ────────────────────────────────────
  let signals = await readPerformanceLearning();
  if (!signals || signals.totalTrades < MIN_TRADES_FOR_PATTERNS) {
    // Try computing fresh
    signals = await computePerformanceLearning().catch(() => null);
  }

  if (!signals || signals.totalTrades < MIN_TRADES_FOR_PATTERNS) {
    await writeProfitEngineState({ ...state, lastRunAt: nowIso(), engineActive: false });
    return result;
  }

  result.winRate = signals.winRate;
  result.avgR = signals.avgR;

  // Build per-tier metrics from analytics
  const allTrades = await readTrades().catch(() => []);
  const closedTrades = extractClosedTrades(Array.isArray(allTrades) ? allTrades : []);
  const analytics = buildAnalytics(closedTrades);

  const tierWinRates: Record<string, number> = {};
  const tierAvgRs: Record<string, number> = {};
  const tierTradeCounts: Record<string, number> = {};
  for (const [tier, stats] of Object.entries(analytics.byTier)) {
    tierWinRates[tier] = stats.winRate / 100; // convert percent → decimal
    tierAvgRs[tier] = stats.avgR;
    tierTradeCounts[tier] = stats.trades;
  }

  const currentMetrics: ExperimentMetrics = {
    winRate: signals.winRate,
    avgR: signals.avgR,
    tradeCount: signals.totalTrades,
    measuredAt: nowIso(),
  };

  // ── Step 3: Evaluate active experiments (feedback loop) ────────────────────
  const expEval = await evaluateActiveExperiments(currentMetrics).catch(() => ({
    evaluated: 0,
    revertsRecommended: 0,
    impact: null,
  }));
  result.experimentsEvaluated = expEval.evaluated;
  result.revertsRecommended = expEval.revertsRecommended;

  // ── Step 4: Detect patterns ────────────────────────────────────────────────
  const patterns = detectProfitPatterns({
    winRate: signals.winRate,
    avgR: signals.avgR,
    tradeCount: signals.totalTrades,
    tierWinRates,
    tierAvgRs,
    tierTradeCounts,
    funnelConversion: funnelCheck.conversion,
    weakSetupClasses: signals.weakSetupClasses,
  });

  result.patternsDetected = patterns.map((p) => p.id);

  // ── Step 5: Generate tasks (deduped) ──────────────────────────────────────
  const newTaskIds: string[] = [];
  const expIds: string[] = [];

  for (const pattern of patterns) {
    const isDupe = await patternAlreadyHasOpenTask(pattern.id, existingTasks).catch(() => false);
    if (isDupe) continue;
    const isRecentDupe = await isRecentDuplicateTask(pattern.title).catch(() => false);
    if (isRecentDupe) {
      console.log(`[PROFIT-ENGINE] Skipping duplicate task (24h window): ${pattern.title}`);
      continue;
    }

    const saved = await createOptimizationTask(pattern).catch(() => null);
    if (!saved) continue;

    newTaskIds.push(saved.id);

    // Open experiment for this optimization
    const exp = await openExperiment({
      taskId: saved.id,
      optimizationType: pattern.optimizationType,
      description: pattern.summary,
      targetFiles: pattern.likelyFiles,
      beforeMetrics: currentMetrics,
      minTradesForEval: 5,
    }).catch(() => null);
    if (exp) expIds.push(exp.id);
  }

  result.tasksCreated = newTaskIds;
  result.experimentsOpened = expIds;

  // ── Step 6: Persist state ─────────────────────────────────────────────────
  const lastPattern = newTaskIds.length > 0 ? patterns[0]?.optimizationType ?? null : state.lastOptimizationType;
  await writeProfitEngineState({
    lastRunAt: nowIso(),
    lastOptimizationType: lastPattern,
    lastOptimizationAt: newTaskIds.length > 0 ? nowIso() : state.lastOptimizationAt,
    lastWinRate: signals.winRate,
    lastAvgR: signals.avgR,
    lastTradeCount: signals.totalTrades,
    funnelBlocked: false,
    funnelBlockedReason: null,
    engineActive: true,
    tasksCreatedThisRun: newTaskIds,
    experimentsOpenedThisRun: expIds,
    optimizationImpact: expEval.impact ?? state.optimizationImpact,
    evaluationLog: [
      ...state.evaluationLog.slice(-10),
      `${nowIso()}: ran — patterns=${patterns.length} tasks=${newTaskIds.length} expEval=${expEval.evaluated} reverts=${expEval.revertsRecommended}`,
    ],
  });

  console.log(
    `[PROFIT-ENGINE] Run complete: patterns=${patterns.length} tasks=${newTaskIds.length} ` +
      `expEval=${expEval.evaluated} reverts=${expEval.revertsRecommended} ` +
      `winRate=${signals.winRate} avgR=${signals.avgR}`,
  );

  return result;
}
