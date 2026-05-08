/**
 * Task Factory — Profit-First Task Creation
 *
 * Creates ManualActionTasks from trading health issues detected by
 * evaluateTradingHealth(). CRITICAL issue types bypass normal queue
 * ordering and are always execution-ready.
 */

import {
  createManualActionTask,
  findDuplicateManualTask,
  type ManualActionPriority,
  type ManualActionTaskType,
} from "@/lib/agents/manual-action-queue";
import type { TradingIssue, TradingIssueType } from "@/lib/agents/tradingSignals";
import { checkIssue, claimIssue } from "@/lib/agents/issue-registry";

// ─── Issue metadata ───────────────────────────────────────────────────────────

/** Deterministic registry key for each trading health issue type. */
export const TRADING_HEALTH_ISSUE_KEYS: Record<TradingIssueType, string> = {
  NEGATIVE_R:    "negative_r",
  RISK_BREACH:   "risk_breach",
  LATENCY:       "latency_above_threshold",
  STALE_SIGNALS: "stale_signals",
  LOW_EXECUTION: "low_execution_rate",
};

const FACTORY_OWNER = "trading_health_monitor";

interface IssueTaskConfig {
  priority: ManualActionPriority;
  taskType: ManualActionTaskType;
  title: string;
  description: string;
  fileHints: string[];
  routeHints: string[];
}

const CRITICAL_ISSUE_TYPES = new Set<TradingIssueType>([
  "NEGATIVE_R",
  "RISK_BREACH",
  "LATENCY",
  "STALE_SIGNALS",
]);

const ISSUE_CONFIGS: Record<TradingIssueType, IssueTaskConfig> = {
  NEGATIVE_R: {
    priority: "CRITICAL",
    taskType: "OPS",
    title: "CRITICAL: Negative average R detected — review exit strategy",
    description:
      "Average realized R across recent closed trades is negative. " +
      "Immediate review of stop management and exit discipline required.",
    fileHints: [
      "lib/agents/performanceLearning.ts",
      "lib/autoEntry/guardrails.ts",
      "lib/risk/protection-integrity.ts",
    ],
    routeHints: ["/api/performance/learning", "/api/trades?view=closed"],
  },

  RISK_BREACH: {
    priority: "CRITICAL",
    taskType: "OPS",
    title: "CRITICAL: Risk breach — realized R below -2R threshold",
    description:
      "A trade exceeded the -2R maximum loss threshold. " +
      "Review stop placement and risk controls immediately.",
    fileHints: [
      "lib/risk/protection-integrity.ts",
      "lib/risk/stop-verification.ts",
      "app/api/trades/protection-audit/route.ts",
    ],
    routeHints: [
      "/api/trades/protection-audit?enforce=1",
      "/api/trades?view=closed",
    ],
  },

  LATENCY: {
    priority: "CRITICAL",
    taskType: "SELF_HEAL",
    title: "CRITICAL: Pipeline latency exceeds 5-minute threshold",
    description:
      "Signal processing or trade activity latency exceeds 300 seconds. " +
      "Check signal ingestion, scoring pipeline, and funnel health.",
    fileHints: [
      "app/api/funnel-health/route.ts",
      "app/api/ai/score/drain/route.ts",
      "app/api/signals/all/route.ts",
    ],
    routeHints: ["/api/funnel-health", "/api/readiness", "/api/ai/score/drain"],
  },

  STALE_SIGNALS: {
    priority: "CRITICAL",
    taskType: "SELF_HEAL",
    title: "CRITICAL: Over 30% of signals are stale",
    description:
      "More than 30% of evaluated signals are outside freshness threshold. " +
      "Check signal feed, scoring cadence, and seed freshness configuration.",
    fileHints: [
      "app/api/auto-entry/seed-from-signals/route.ts",
      "app/api/ai/score/drain/route.ts",
      "lib/autoEntry/guardrails.ts",
    ],
    routeHints: [
      "/api/auto-entry/seed-from-signals",
      "/api/funnel-health",
      "/api/signals/all",
    ],
  },

  LOW_EXECUTION: {
    priority: "HIGH",
    taskType: "SELF_HEAL",
    title: "HIGH: Low execution rate — fewer than 50% of qualified signals seeded",
    description:
      "Execution rate is below 50%. Qualified signals are not converting " +
      "to trades at sufficient rate. Review capacity limits, guardrails, and " +
      "seeding thresholds.",
    fileHints: [
      "app/api/auto-entry/seed-from-signals/route.ts",
      "lib/autoEntry/guardrails.ts",
      "lib/autoEntry/guardrailsStore.ts",
    ],
    routeHints: [
      "/api/auto-entry/seed-from-signals",
      "/api/funnel-health",
      "/api/readiness",
    ],
  },
};

// ─── Public API ───────────────────────────────────────────────────────────────

export interface CreateTaskOptions {
  /**
   * When true, bypass deduplication and always create the task.
   * Automatically set for CRITICAL issues.
   */
  force?: boolean;
}

export interface CreateTaskResult {
  created: boolean;
  deduped: boolean;
  taskId: string | null;
  issueType: TradingIssueType;
  reason?: string;
}

/**
 * Create a ManualActionTask from a trading health issue.
 *
 * CRITICAL issue types:
 * - Always set priority = "CRITICAL"
 * - Always set executionReady = true
 * - Bypass normal queue ordering (inserted at head via CRITICAL priority)
 * - Bypass deduplication when force=true or issue.severity === "CRITICAL"
 */
export async function createTask(
  issue: TradingIssue,
  options: CreateTaskOptions = {},
): Promise<CreateTaskResult> {
  const config = ISSUE_CONFIGS[issue.type];
  const issueKey = TRADING_HEALTH_ISSUE_KEYS[issue.type];
  const isCritical = CRITICAL_ISSUE_TYPES.has(issue.type);
  const forceCreate = options.force === true || issue.severity === "CRITICAL";

  // ── Issue registry gate — prevents duplicate patches within 30-min window ─
  const gate = await checkIssue(issueKey, FACTORY_OWNER);
  if (gate.action === "SKIP") {
    return {
      created: false,
      deduped: true,
      taskId: null,
      issueType: issue.type,
      reason: `registry_skip:${gate.reason}`,
    };
  }

  // CRITICAL issues are always execution-ready and bypass queue ordering
  const priority: ManualActionPriority = isCritical ? "CRITICAL" : config.priority;
  const executionReady = true; // all health tasks are actionable

  // Task-level dedup check: only skip for non-CRITICAL issues
  if (!forceCreate) {
    const existing = await findDuplicateManualTask(config.title, config.taskType);
    if (existing) {
      return {
        created: false,
        deduped: true,
        taskId: existing.id,
        issueType: issue.type,
        reason: "duplicate_active_task",
      };
    }
  }

  const task = await createManualActionTask({
    title: config.title,
    description: config.description,
    priority,
    taskType: config.taskType,
    executionReady,
    fileHints: config.fileHints,
    routeHints: config.routeHints,
    source: "trading_health_monitor",
    objective: `Resolve ${issue.type} issue detected by trading health monitor`,
  });

  if (!task) {
    return {
      created: false,
      deduped: false,
      taskId: null,
      issueType: issue.type,
      reason: "redis_unavailable",
    };
  }

  // Claim the issue after successful task creation (sets IN_PROGRESS + owner)
  await claimIssue(issueKey, FACTORY_OWNER).catch(() => {});

  return {
    created: true,
    deduped: false,
    taskId: task.id,
    issueType: issue.type,
  };
}
