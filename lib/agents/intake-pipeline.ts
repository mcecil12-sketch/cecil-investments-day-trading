/**
 * Shared Chat-Intake Pipeline
 *
 * Contains the entire validate → downgrade → dedup → create → auto-execute
 * → compact-state pipeline used by both /api/agents/chat-intake and
 * /api/agents/chat-command.  Extracting it here prevents the two routes
 * from drifting.
 */

import {
  createManualActionTask,
  findDuplicateManualTask,
  countOpenExecutionReadyManualTasks,
  getActiveManualTask,
  type ManualActionTaskType,
  type ManualActionTaskInput,
} from "@/lib/agents/manual-action-queue";
import { getCriticalTasks, partitionCriticalTasks } from "@/lib/redis";
import {
  normalizeIntakePayload,
  type IntakePayload,
  type NormalizedIntakeResult,
  type IntakeValidationError,
} from "@/lib/agents/task-normalizer";
import {
  isConversationalTask,
  parseConversationalTask,
} from "@/lib/agents/conversational-task-parser";

// ─── Re-export parser utilities so consumers don't need a second import ─

export { isConversationalTask, parseConversationalTask };

// ─── Patchable task types that strongly need fileHints ───────────────

const PATCHABLE_TYPES: Set<ManualActionTaskType> = new Set([
  "BUGFIX", "SCORING", "AUTO_ENTRY", "SELF_HEAL", "OPTIMIZATION",
]);

// ─── Internal execute trigger ───────────────────────────────────────

function resolveBaseUrl(): string {
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL.replace(/\/+$/, "");
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  if (process.env.NEXTAUTH_URL) return process.env.NEXTAUTH_URL.replace(/\/+$/, "");
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

function buildInternalHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cache-control": "no-store",
  };
  const cronToken = process.env.CRON_TOKEN ?? process.env.CRON_SECRET ?? "";
  if (cronToken) headers["x-cron-token"] = cronToken;
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? "";
  if (bypassSecret) headers["x-vercel-protection-bypass"] = bypassSecret;
  return headers;
}

// ─── Auto-execute evaluation ────────────────────────────────────────

export interface AutoExecuteResult {
  attempted: boolean;
  triggered: boolean;
  skippedReason: string | null;
}

export async function evaluateAutoExecute(
  executionReady: boolean,
): Promise<AutoExecuteResult> {
  if (!executionReady) {
    return { attempted: false, triggered: false, skippedReason: "task_not_execution_ready" };
  }

  try {
    const criticalTasks = await getCriticalTasks();
    const { blocking } = partitionCriticalTasks(criticalTasks);
    if (blocking.length > 0) {
      return { attempted: true, triggered: false, skippedReason: "blocking_critical_incident" };
    }
  } catch { /* non-fatal */ }

  try {
    const active = await getActiveManualTask();
    if (active && (active.status === "IN_PROGRESS" || active.status === "SELECTED")) {
      return { attempted: true, triggered: false, skippedReason: "manual_task_already_active" };
    }
  } catch { /* non-fatal */ }

  try {
    const counts = await countOpenExecutionReadyManualTasks();
    if (counts.inProgressCount > 0) {
      return { attempted: true, triggered: false, skippedReason: "executor_busy" };
    }
  } catch { /* non-fatal */ }

  try {
    const base = resolveBaseUrl();
    const headers = buildInternalHeaders();
    fetch(`${base}/api/agents/execute`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(5_000),
    }).catch(() => { /* fire-and-forget */ });
    return { attempted: true, triggered: true, skippedReason: null };
  } catch {
    return { attempted: true, triggered: false, skippedReason: "trigger_failed" };
  }
}

// ─── Compact state snapshot ─────────────────────────────────────────

export async function getCompactState() {
  const [activeTask, counts] = await Promise.all([
    getActiveManualTask().catch(() => null),
    countOpenExecutionReadyManualTasks().catch(() => ({
      openCount: 0, executionReadyCount: 0, inProgressCount: 0, blockedCount: 0, selectedCount: 0,
    })),
  ]);

  let blockingIncidentCount = 0;
  try {
    const criticals = await getCriticalTasks();
    const { blocking } = partitionCriticalTasks(criticals);
    blockingIncidentCount = blocking.length;
  } catch { /* non-fatal */ }

  return {
    queueCounts: counts,
    activeManualTask: activeTask
      ? {
          id: activeTask.id,
          title: activeTask.title,
          status: activeTask.status,
          priority: activeTask.priority,
          taskType: activeTask.taskType,
          executionReady: activeTask.executionReady,
          blockedReason: activeTask.blockedReason ?? null,
          latestExecutionResult: activeTask.latestExecutionResult ?? null,
        }
      : null,
    blockingIncidentCount,
  };
}

// ─── Resolve payload: conversational message OR structured JSON ─────

export type ResolvePayloadResult =
  | { ok: true; raw: IntakePayload; conversational: boolean }
  | { ok: false; error: string; status: 400 };

/**
 * Given the raw JSON body from the request, determine whether it is a
 * conversational message (has a `message` field starting with the trigger
 * phrase) or a plain structured payload.  Returns a normalised IntakePayload
 * in both cases.
 */
export function resolvePayload(
  body: Record<string, unknown>,
): ResolvePayloadResult {
  const message = typeof body.message === "string" ? body.message.trim() : "";

  if (message && isConversationalTask(message)) {
    const parsed = parseConversationalTask(message);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error, status: 400 };
    }
    return { ok: true, raw: parsed.payload, conversational: true };
  }

  // Treat the body itself as a structured IntakePayload
  return { ok: true, raw: body as IntakePayload, conversational: false };
}

// ─── Full intake pipeline result ────────────────────────────────────

export interface IntakePipelineSuccess {
  ok: true;
  status: 200 | 201;
  body: Record<string, unknown>;
}

export interface IntakePipelineError {
  ok: false;
  status: number;
  body: Record<string, unknown>;
}

export type IntakePipelineResult = IntakePipelineSuccess | IntakePipelineError;

/**
 * Run the full intake pipeline:
 *   resolve payload → normalise → fileHint downgrade → blocking check →
 *   dedup → create → auto-execute → compact state → response body.
 */
export async function runIntakePipeline(
  body: Record<string, unknown>,
): Promise<IntakePipelineResult> {
  // 1. Resolve conversational vs structured
  const resolved = resolvePayload(body);
  if (!resolved.ok) {
    return { ok: false, status: resolved.status, body: { ok: false, error: resolved.error } };
  }

  const raw = resolved.raw;

  // Default source
  if (!raw.source) raw.source = "chat_intake";

  // 2. Normalise & validate
  const normalized: NormalizedIntakeResult | IntakeValidationError = normalizeIntakePayload(raw);
  if (!normalized.ok) {
    return {
      ok: false,
      status: 400,
      body: { ok: false, error: normalized.error, field: normalized.field },
    };
  }

  const { input } = normalized;
  let warning: string | null = null;

  // 3. FileHints validation for patchable execution-ready tasks
  if (
    input.executionReady &&
    PATCHABLE_TYPES.has(input.taskType) &&
    (!input.fileHints || input.fileHints.length === 0)
  ) {
    input.executionReady = false;
    warning =
      "executionReady downgraded to false: patchable task type " +
      input.taskType +
      " requires fileHints for execution. Add fileHints and update the task to re-enable.";
  }

  // 4. Blocking incident check (early warning)
  let blockingIncidentCount = 0;
  try {
    const criticals = await getCriticalTasks();
    const { blocking } = partitionCriticalTasks(criticals);
    blockingIncidentCount = blocking.length;
  } catch { /* non-fatal */ }

  if (blockingIncidentCount > 0 && input.executionReady) {
    warning = (warning ? warning + " | " : "") +
      `${blockingIncidentCount} blocking critical incident(s) exist — execution will be skipped.`;
  }

  // Build the parsedPayload summary included in every response
  const parsedPayload = {
    title: input.title,
    description: input.description,
    priority: input.priority,
    taskType: input.taskType,
    executionReady: input.executionReady,
    source: input.source,
  };

  // 5. Duplicate detection
  const duplicate = await findDuplicateManualTask(input.title, input.taskType);
  if (duplicate) {
    const state = await getCompactState();
    return {
      ok: true,
      status: 200,
      body: {
        ok: true,
        created: false,
        deduped: true,
        duplicateTaskId: duplicate.id,
        parsedPayload,
        task: {
          id: duplicate.id,
          title: duplicate.title,
          status: duplicate.status,
          priority: duplicate.priority,
          taskType: duplicate.taskType,
          executionReady: duplicate.executionReady,
        },
        autoExecute: { attempted: false, triggered: false, skippedReason: "deduped_existing_active_task" },
        warning: warning ?? "Duplicate task already active — not re-created.",
        ...state,
      },
    };
  }

  // 6. Create task
  const task = await createManualActionTask(input);
  if (!task) {
    return {
      ok: false,
      status: 500,
      body: { ok: false, error: "Failed to create task (Redis unavailable)" },
    };
  }

  // 7. Auto-execute
  const autoExecute = await evaluateAutoExecute(task.executionReady);

  // 8. Compact state for response
  const state = await getCompactState();

  return {
    ok: true,
    status: 201,
    body: {
      ok: true,
      created: true,
      deduped: false,
      parsedPayload,
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        priority: task.priority,
        taskType: task.taskType,
        executionReady: task.executionReady,
        source: task.source,
      },
      autoExecute,
      warning,
      ...state,
    },
  };
}
