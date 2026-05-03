/**
 * Adaptive Guardrail Engine — Phase 4
 *
 * Detects harmful recent trading patterns from performance learning signals,
 * auto-applies safe, bounded, reversible guardrail tightenings, and creates
 * execution-ready tasks for anything that requires deeper changes.
 *
 * Contract:
 *   - Only low-blast-radius actions are auto-applied
 *   - Every action is logged with reason, timestamp, and expiry
 *   - Every action is reversible
 *   - Non-safe changes become tasks, not silent mutations
 */

import { redis } from "@/lib/redis";
import { getTtlSeconds } from "@/lib/redis/ttl";
import { AGENT_ADAPTIVE_GUARDRAILS_KEY } from "@/lib/agents/keys";
import { readPerformanceLearning } from "@/lib/agents/performanceLearning";
import { appendEngineeringTask } from "@/lib/agents/store";
import { isRecentDuplicateTask } from "@/lib/agents/task-dedup";
import { nowIso } from "@/lib/agents/time";
import type {
  AdaptiveActionType,
  AdaptiveGuardrailAction,
  AdaptiveGuardrailState,
  EngineeringTask,
  PerformanceLearningSignals,
} from "@/lib/agents/types";

const STORE_TTL = getTtlSeconds("TELEMETRY_DAYS");
const DEFAULT_ACTION_TTL_HOURS = 4;
const MAX_ACTIVE_ACTIONS = 10;

// ─── Pattern Detection ──────────────────────────────────────────────

interface DetectedPattern {
  pattern: string;
  actionType: AdaptiveActionType;
  reason: string;
  appliedValue: number | string | boolean;
  previousValue: number | string | boolean | null;
  safe: boolean;
}

function detectPatterns(signals: PerformanceLearningSignals): DetectedPattern[] {
  const patterns: DetectedPattern[] = [];

  // 1. Deep loss rate too high (>15%)
  if (signals.deepLossRate > 0.15 && signals.totalTrades >= 5) {
    patterns.push({
      pattern: "deep_loss_rate_elevated",
      actionType: "reduce_max_open_positions",
      reason: `Deep loss rate ${(signals.deepLossRate * 100).toFixed(1)}% exceeds 15% threshold over ${signals.totalTrades} trades`,
      appliedValue: 2,
      previousValue: null, // filled from current config
      safe: true,
    });
  }

  // 2. Long side materially underperforming short side
  if (
    signals.longVsShortImbalance.startsWith("long_underperforming") &&
    signals.totalTrades >= 8
  ) {
    patterns.push({
      pattern: "long_side_underperforming",
      actionType: "suppress_side",
      reason: `Long side underperforming: ${signals.longVsShortImbalance}`,
      appliedValue: "suppress_long",
      previousValue: null,
      safe: true,
    });
  }

  // 3. Short side materially underperforming
  if (
    signals.shortWinRate < 0.35 &&
    signals.totalTrades >= 8 &&
    signals.weakSetupClasses.includes("short_side_low_win_rate")
  ) {
    patterns.push({
      pattern: "short_side_low_win_rate",
      actionType: "suppress_side",
      reason: `Short side win rate ${(signals.shortWinRate * 100).toFixed(0)}% < 35% threshold`,
      appliedValue: "suppress_short",
      previousValue: null,
      safe: true,
    });
  }

  // 4. Low overall win rate — raise min score threshold
  if (signals.winRate < 0.4 && signals.totalTrades >= 10) {
    patterns.push({
      pattern: "low_overall_win_rate",
      actionType: "raise_min_score_threshold",
      reason: `Overall win rate ${(signals.winRate * 100).toFixed(0)}% < 40% over ${signals.totalTrades} trades`,
      appliedValue: 1.0, // raise threshold by +1.0
      previousValue: 0,
      safe: true,
    });
  }

  // 5. Too many trades failing before 1R
  if (signals.avgR < -0.3 && signals.totalTrades >= 5) {
    patterns.push({
      pattern: "negative_avg_r",
      actionType: "reduce_max_entries_per_day",
      reason: `Average R ${signals.avgR.toFixed(2)} is deeply negative — reducing daily entry count`,
      appliedValue: 3,
      previousValue: null,
      safe: true,
    });
  }

  // 6. Deep loss spike — increase cooldown after loss
  if (signals.deepLossCount >= 3 && signals.deepLossRate > 0.12) {
    patterns.push({
      pattern: "deep_loss_spike",
      actionType: "increase_cooldown_after_loss",
      reason: `${signals.deepLossCount} deep losses (${(signals.deepLossRate * 100).toFixed(1)}% rate) — increasing cooldown`,
      appliedValue: 40, // minutes
      previousValue: null,
      safe: true,
    });
  }

  // ─── NON-SAFE patterns → create tasks instead ──────────────────────

  // Scoring prompt changes needed
  if (signals.winRate < 0.3 && signals.totalTrades >= 15) {
    patterns.push({
      pattern: "scoring_quality_degraded",
      actionType: "raise_min_score_threshold", // placeholder
      reason: `Win rate ${(signals.winRate * 100).toFixed(0)}% critically low — scoring prompt review needed`,
      appliedValue: "task_only",
      previousValue: null,
      safe: false,
    });
  }

  // Strategy mode underperforming
  for (const weakClass of signals.weakSetupClasses) {
    if (weakClass.startsWith("tier_") && weakClass.endsWith("_high_loss_rate")) {
      patterns.push({
        pattern: `weak_setup_class_${weakClass}`,
        actionType: "suppress_mode",
        reason: `Weak setup class detected: ${weakClass}`,
        appliedValue: "task_only",
        previousValue: null,
        safe: false,
      });
    }
  }

  return patterns;
}

// ─── Action Application ─────────────────────────────────────────────

function createAction(
  pattern: DetectedPattern,
  ttlHours: number = DEFAULT_ACTION_TTL_HOURS,
): AdaptiveGuardrailAction {
  const now = nowIso();
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();
  return {
    id: `adaptive-${pattern.pattern}-${Date.now().toString(36)}`,
    actionType: pattern.actionType,
    reason: pattern.reason,
    triggerPattern: pattern.pattern,
    appliedAt: now,
    expiresAt,
    status: "ACTIVE",
    previousValue: pattern.previousValue,
    appliedValue: pattern.appliedValue,
    rolledBackAt: null,
  };
}

// ─── Storage ────────────────────────────────────────────────────────

export async function readAdaptiveGuardrailState(): Promise<AdaptiveGuardrailState> {
  const empty: AdaptiveGuardrailState = {
    actions: [],
    lastEvaluatedAt: null,
    evaluationSource: null,
  };
  if (!redis) return empty;
  try {
    const raw = await redis.get<string>(AGENT_ADAPTIVE_GUARDRAILS_KEY);
    if (!raw) return empty;
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === "object" && "actions" in parsed) {
      return parsed as AdaptiveGuardrailState;
    }
    return empty;
  } catch {
    return empty;
  }
}

async function writeAdaptiveGuardrailState(state: AdaptiveGuardrailState): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(AGENT_ADAPTIVE_GUARDRAILS_KEY, JSON.stringify(state), { ex: STORE_TTL });
  } catch {
    // non-fatal
  }
}

// ─── Active Action Queries ──────────────────────────────────────────

export function getActiveActions(state: AdaptiveGuardrailState): AdaptiveGuardrailAction[] {
  const now = Date.now();
  return state.actions.filter(
    (a) => a.status === "ACTIVE" && new Date(a.expiresAt).getTime() > now,
  );
}

export function getEffectiveMaxOpenPositions(
  baseValue: number,
  actions: AdaptiveGuardrailAction[],
): number {
  let effective = baseValue;
  for (const a of actions) {
    if (a.actionType === "reduce_max_open_positions" && typeof a.appliedValue === "number") {
      effective = Math.min(effective, a.appliedValue);
    }
  }
  return Math.max(1, effective);
}

export function getEffectiveMaxEntriesPerDay(
  baseValue: number,
  actions: AdaptiveGuardrailAction[],
): number {
  let effective = baseValue;
  for (const a of actions) {
    if (a.actionType === "reduce_max_entries_per_day" && typeof a.appliedValue === "number") {
      effective = Math.min(effective, a.appliedValue);
    }
  }
  return Math.max(1, effective);
}

export function getEffectiveMinScoreAdjustment(
  baseValue: number,
  actions: AdaptiveGuardrailAction[],
): number {
  let adjustment = baseValue;
  for (const a of actions) {
    if (a.actionType === "raise_min_score_threshold" && typeof a.appliedValue === "number") {
      adjustment = Math.max(adjustment, a.appliedValue);
    }
  }
  return adjustment;
}

export function getEffectiveCooldownAfterLoss(
  baseValue: number,
  actions: AdaptiveGuardrailAction[],
): number {
  let effective = baseValue;
  for (const a of actions) {
    if (a.actionType === "increase_cooldown_after_loss" && typeof a.appliedValue === "number") {
      effective = Math.max(effective, a.appliedValue);
    }
  }
  return effective;
}

export function getSuppressedSides(actions: AdaptiveGuardrailAction[]): string[] {
  const sides: string[] = [];
  for (const a of actions) {
    if (a.actionType === "suppress_side" && typeof a.appliedValue === "string") {
      if (a.appliedValue === "suppress_long") sides.push("LONG");
      if (a.appliedValue === "suppress_short") sides.push("SHORT");
    }
  }
  return sides;
}

// ─── Main Evaluation ────────────────────────────────────────────────

export interface AdaptiveEvaluationResult {
  evaluated: boolean;
  actionsApplied: AdaptiveGuardrailAction[];
  tasksCreated: string[];
  expiredActions: string[];
  activeActions: AdaptiveGuardrailAction[];
  signals: PerformanceLearningSignals | null;
}

export async function evaluateAdaptiveGuardrails(): Promise<AdaptiveEvaluationResult> {
  const result: AdaptiveEvaluationResult = {
    evaluated: false,
    actionsApplied: [],
    tasksCreated: [],
    expiredActions: [],
    activeActions: [],
    signals: null,
  };

  // 1. Read performance signals
  const signals = await readPerformanceLearning();
  if (!signals || signals.totalTrades < 5) {
    console.log("[ADAPTIVE-GUARDRAILS] Insufficient trade data for evaluation");
    return result;
  }
  result.signals = signals;

  // 2. Read current state
  const state = await readAdaptiveGuardrailState();

  // 3. Expire old actions
  const now = Date.now();
  for (const action of state.actions) {
    if (action.status === "ACTIVE" && new Date(action.expiresAt).getTime() <= now) {
      action.status = "EXPIRED";
      action.rolledBackAt = nowIso();
      result.expiredActions.push(action.id);
      console.log(`[ADAPTIVE-GUARDRAILS] Expired action ${action.id}: ${action.reason}`);
    }
  }

  // 4. Detect patterns
  const patterns = detectPatterns(signals);

  // 5. Apply safe actions (if not already active for same pattern)
  const activePatterns = new Set(
    state.actions
      .filter((a) => a.status === "ACTIVE" && new Date(a.expiresAt).getTime() > now)
      .map((a) => a.triggerPattern),
  );

  for (const pattern of patterns) {
    if (activePatterns.has(pattern.pattern)) {
      continue; // already active — don't duplicate
    }

    if (pattern.safe) {
      if (state.actions.filter((a) => a.status === "ACTIVE").length >= MAX_ACTIVE_ACTIONS) {
        console.log(`[ADAPTIVE-GUARDRAILS] Max active actions reached, skipping ${pattern.pattern}`);
        continue;
      }

      const action = createAction(pattern);
      state.actions.push(action);
      result.actionsApplied.push(action);
      console.log(`[ADAPTIVE-GUARDRAILS] Applied action ${action.id}: ${action.reason} (expires ${action.expiresAt})`);
    } else {
      // Create execution-ready task for non-safe changes
      try {
        const taskTitle = `[Adaptive] ${pattern.reason}`;
        const isDuplicate = await isRecentDuplicateTask(taskTitle);
        if (isDuplicate) {
          console.log(`[ADAPTIVE-GUARDRAILS] Skipping duplicate task for pattern: ${pattern.pattern}`);
          continue;
        }
        const task: EngineeringTask = {
          id: `adaptive-${pattern.pattern}-${Date.now().toString(36)}`,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          status: "OPEN",
          title: taskTitle,
          summary: `Performance-driven pattern detected: ${pattern.pattern}. Requires manual review — not auto-applicable. Triggered reason: ${pattern.reason}`,
          likelyFiles: [],
          copilotPrompt: `Review and address performance pattern: ${pattern.pattern}. ${pattern.reason}`,
          smokeTestBlock: "GET /api/readiness\nGET /api/auto-entry/summary",
          gitBlock: "",
        };
        const saved = await appendEngineeringTask(task);
        result.tasksCreated.push(saved.id);
        console.log(`[ADAPTIVE-GUARDRAILS] Created task ${saved.id} for non-safe pattern: ${pattern.pattern}`);
      } catch (err) {
        console.error(`[ADAPTIVE-GUARDRAILS] Failed to create task for ${pattern.pattern}:`, err);
      }
    }
  }

  // 6. Trim old expired/rolled-back actions (keep last 50)
  state.actions = state.actions.slice(-50);
  state.lastEvaluatedAt = nowIso();
  state.evaluationSource = "performance_learning";

  // 7. Persist
  await writeAdaptiveGuardrailState(state);

  result.evaluated = true;
  result.activeActions = getActiveActions(state);
  return result;
}

// ─── Rollback ───────────────────────────────────────────────────────

export async function rollbackAction(actionId: string): Promise<boolean> {
  const state = await readAdaptiveGuardrailState();
  const action = state.actions.find((a) => a.id === actionId);
  if (!action || action.status !== "ACTIVE") return false;

  action.status = "ROLLED_BACK";
  action.rolledBackAt = nowIso();
  await writeAdaptiveGuardrailState(state);
  console.log(`[ADAPTIVE-GUARDRAILS] Rolled back action ${actionId}`);
  return true;
}
