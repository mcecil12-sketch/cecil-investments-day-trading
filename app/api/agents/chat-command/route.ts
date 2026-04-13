export const dynamic = "force-dynamic";

/**
 * POST /api/agents/chat-command
 *
 * Conversational execution trigger for agent intake.
 *
 * Accepts a JSON body with a `message` field.  When the message starts with
 * "Execute the following task:" the body after the trigger is parsed for
 * structured fields (Title, Type, Priority, Execute, Description,
 * Acceptance Criteria, File Hints, Route Hints) and fed into the standard
 * chat-intake flow.
 *
 * Defaults:
 *   Type     = OPS
 *   Priority = MEDIUM
 *   Execute  = false
 *
 * Returns the same compact JSON envelope as /api/agents/chat-intake.
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
import { normalizeIntakePayload } from "@/lib/agents/task-normalizer";
import {
  isConversationalTask,
  parseConversationalTask,
} from "@/lib/agents/conversational-task-parser";

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

// ─── Compact state snapshot ─────────────────────────────────────────

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

  let body: { message?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const message = typeof body.message === "string" ? body.message : "";
  if (!message) {
    return NextResponse.json(
      { ok: false, error: "Missing required field: message" },
      { status: 400 },
    );
  }

  // Only handle the "Execute the following task:" trigger
  if (!isConversationalTask(message)) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Message must begin with "Execute the following task:"',
      },
      { status: 400 },
    );
  }

  // Parse conversational payload
  const parsed = parseConversationalTask(message);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, error: parsed.error },
      { status: 400 },
    );
  }

  const { payload } = parsed;

  // Normalize & validate through the standard normalizer
  const normalized = normalizeIntakePayload(payload);
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
      parsedPayload: {
        title: input.title,
        description: input.description,
        priority: input.priority,
        taskType: input.taskType,
        executionReady: input.executionReady,
        source: input.source,
      },
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
      parsedPayload: {
        title: input.title,
        description: input.description,
        priority: input.priority,
        taskType: input.taskType,
        executionReady: input.executionReady,
        source: input.source,
      },
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
