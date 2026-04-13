/**
 * Chat-to-Agent execution bridge.
 *
 * Thin server-side helper that validates an intake payload and POSTs to
 * /api/agents/intake.  This keeps all queue logic in one place (the intake
 * route) while giving UI components a typesafe way to submit tasks.
 */

import { normalizeIntakePayload, type IntakePayload } from "./task-normalizer";
import type { ManualActionTask, ManualActionTaskType } from "./manual-action-queue";

// ─── Template definitions ───────────────────────────────────────────

export interface TaskTemplate {
  key: string;
  label: string;
  taskType: ManualActionTaskType;
  priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  descriptionHint: string;
  executionReady: boolean;
  needsFileHints: boolean;
}

export const TASK_TEMPLATES: TaskTemplate[] = [
  {
    key: "scoring",
    label: "Scoring tune",
    taskType: "SCORING",
    priority: "HIGH",
    descriptionHint: "Adjust AI scoring weights or thresholds",
    executionReady: true,
    needsFileHints: true,
  },
  {
    key: "self_heal",
    label: "Self-heal",
    taskType: "SELF_HEAL",
    priority: "HIGH",
    descriptionHint: "Auto-detect and fix a degraded sub-system",
    executionReady: true,
    needsFileHints: false,
  },
  {
    key: "ops",
    label: "Ops check",
    taskType: "OPS",
    priority: "MEDIUM",
    descriptionHint: "Run an operational health check or maintenance task",
    executionReady: false,
    needsFileHints: false,
  },
  {
    key: "auto_entry",
    label: "Auto-entry fix",
    taskType: "AUTO_ENTRY",
    priority: "HIGH",
    descriptionHint: "Fix or tune auto-entry logic",
    executionReady: true,
    needsFileHints: true,
  },
  {
    key: "bugfix",
    label: "Bug fix",
    taskType: "BUGFIX",
    priority: "HIGH",
    descriptionHint: "Fix a specific bug found in production",
    executionReady: true,
    needsFileHints: true,
  },
];

// ─── Intake bridge result ───────────────────────────────────────────

export interface ChatBridgeResult {
  ok: boolean;
  created: boolean;
  deduped?: boolean;
  task?: ManualActionTask;
  validationError?: string;
  validationField?: string;
  queueCounts?: {
    openCount: number;
    executionReadyCount: number;
    inProgressCount: number;
    blockedCount: number;
    selectedCount: number;
  };
  autoExecute?: {
    attempted: boolean;
    triggered: boolean;
    skippedReason: string | null;
  };
  warning?: string;
}

// ─── Validation helper ──────────────────────────────────────────────

/**
 * Pre-validate an intake payload on the client/server boundary.
 * Returns null when valid, or an error string when not.
 */
export function preValidate(payload: IntakePayload): string | null {
  const result = normalizeIntakePayload(payload);
  if (!result.ok) return result.error;

  // Warn when patchable execution-ready tasks lack fileHints
  const { input } = result;
  const patchableTypes: ManualActionTaskType[] = [
    "BUGFIX", "SCORING", "AUTO_ENTRY", "SELF_HEAL", "OPTIMIZATION",
  ];
  if (
    input.executionReady &&
    patchableTypes.includes(input.taskType) &&
    (!input.fileHints || input.fileHints.length === 0)
  ) {
    // Not a hard block — but the executor will likely block it.
    // Return the warning via ChatBridgeResult.warning instead.
    return null;
  }

  return null;
}

/**
 * Check whether an execution-ready patchable task is missing fileHints.
 * Returns a warning string or null.
 */
export function fileHintWarning(payload: IntakePayload): string | null {
  const result = normalizeIntakePayload(payload);
  if (!result.ok) return null;
  const { input } = result;
  const patchableTypes: ManualActionTaskType[] = [
    "BUGFIX", "SCORING", "AUTO_ENTRY", "SELF_HEAL", "OPTIMIZATION",
  ];
  if (
    input.executionReady &&
    patchableTypes.includes(input.taskType) &&
    (!input.fileHints || input.fileHints.length === 0)
  ) {
    return "Patchable execution-ready tasks strongly benefit from fileHints. The executor may block this task without them.";
  }
  return null;
}
