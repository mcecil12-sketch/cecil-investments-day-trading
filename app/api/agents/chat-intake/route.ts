export const dynamic = "force-dynamic";

/**
 * POST /api/agents/chat-intake
 *
 * Conversation-to-agent bridge endpoint.  Accepts the same payload as
 * /api/agents/intake but returns a compact, GPT-friendly response that
 * includes current queue context (active task, latest execution, queue
 * counts) so callers get a complete picture in one round-trip.
 *
 * Additional behavior vs plain intake:
 *  - For patchable executionReady tasks missing fileHints, executionReady
 *    is safely downgraded to false with a warning instead of silently creating
 *    a task that the executor will block.
 *  - source defaults to "chat_intake".
 */

import { NextRequest, NextResponse } from "next/server";
import { checkAgentReadAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import {
  createManualActionTask,
  findDuplicateManualTask,
  countOpenExecutionReadyManualTasks,
  getActiveManualTask,
  type ManualActionTaskType,
} from "@/lib/agents/manual-action-queue";
import { getCriticalTasks, partitionCriticalTasks } from "@/lib/redis";
import { normalizeIntakePayload, type IntakePayload } from "@/lib/agents/task-normalizer";

// ─── Patchable task types that strongly need fileHints ───────────────

const PATCHABLE_TYPES: Set<ManualActionTaskType> = new Set([
  "BUGFIX", "SCORING", "AUTO_ENTRY", "SELF_HEAL", "OPTIMIZATION",
]);

// ─── Internal execute trigger (same logic as intake route) ──────────

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

interface AutoExecuteResult {
  attempted: boolean;
  triggered: boolean;
  skippedReason: string | null;
}

async function evaluateAutoExecute(
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

// ─── Compact state snapshot for response ────────────────────────────

async function getCompactState() {
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

// ─── POST handler ───────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const auth = await checkAgentReadAuth(req);
  if (!auth.ok) {
    return unauthorizedAgentResponse(auth.error);
  }

  let raw: IntakePayload;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  // Default source to chat_intake
  if (!raw.source) raw.source = "chat_intake";

  // Normalize & validate
  const normalized = normalizeIntakePayload(raw);
  if (!normalized.ok) {
    return NextResponse.json(
      { ok: false, error: normalized.error, field: normalized.field },
      { status: 400 },
    );
  }

  const { input } = normalized;
  let warning: string | null = null;

  // ── FileHints validation for patchable execution-ready tasks ──
  if (
    input.executionReady &&
    PATCHABLE_TYPES.has(input.taskType) &&
    (!input.fileHints || input.fileHints.length === 0)
  ) {
    // Safe downgrade: set executionReady=false and warn
    input.executionReady = false;
    warning =
      "executionReady downgraded to false: patchable task type " +
      input.taskType +
      " requires fileHints for execution. Add fileHints and update the task to re-enable.";
  }

  // ── Blocking incident check (early warning) ──
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

  // ── Duplicate detection ──
  const duplicate = await findDuplicateManualTask(input.title, input.taskType);
  if (duplicate) {
    const state = await getCompactState();
    return NextResponse.json({
      ok: true,
      created: false,
      deduped: true,
      duplicateTaskId: duplicate.id,
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
    });
  }

  // ── Create task ──
  const task = await createManualActionTask(input);
  if (!task) {
    return NextResponse.json(
      { ok: false, error: "Failed to create task (Redis unavailable)" },
      { status: 500 },
    );
  }

  // ── Auto-execute ──
  const autoExecute = await evaluateAutoExecute(task.executionReady);

  // ── Compact state for response ──
  const state = await getCompactState();

  return NextResponse.json(
    {
      ok: true,
      created: true,
      deduped: false,
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
    { status: 201 },
  );
}
