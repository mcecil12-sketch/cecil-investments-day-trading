export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { checkAgentReadAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import {
  createManualActionTask,
  findDuplicateManualTask,
  countOpenExecutionReadyManualTasks,
  getActiveManualTask,
} from "@/lib/agents/manual-action-queue";
import { getCriticalTasks, partitionCriticalTasks } from "@/lib/redis";
import { normalizeIntakePayload, type IntakePayload } from "@/lib/agents/task-normalizer";

// ─── Internal execute trigger helpers ───────────────────────────────

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
  // Guard 1: task must be execution-ready
  if (!executionReady) {
    return { attempted: false, triggered: false, skippedReason: "task_not_execution_ready" };
  }

  // Guard 2: no blocking critical incidents
  try {
    const criticalTasks = await getCriticalTasks();
    const { blocking } = partitionCriticalTasks(criticalTasks);
    if (blocking.length > 0) {
      return { attempted: true, triggered: false, skippedReason: "blocking_critical_incident" };
    }
  } catch {
    // non-fatal — proceed with other checks
  }

  // Guard 3: no active manual task already IN_PROGRESS or SELECTED
  try {
    const active = await getActiveManualTask();
    if (active && (active.status === "IN_PROGRESS" || active.status === "SELECTED")) {
      return { attempted: true, triggered: false, skippedReason: "manual_task_already_active" };
    }
  } catch {
    // non-fatal
  }

  // Guard 4: executor not already busy (check if there's an IN_PROGRESS count)
  try {
    const counts = await countOpenExecutionReadyManualTasks();
    if (counts.inProgressCount > 0) {
      return { attempted: true, triggered: false, skippedReason: "executor_busy" };
    }
  } catch {
    // non-fatal
  }

  // All guards passed — fire-and-forget trigger to /api/agents/execute
  try {
    const base = resolveBaseUrl();
    const headers = buildInternalHeaders();
    // Fire and forget — don't await the full response
    fetch(`${base}/api/agents/execute`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {
      // Swallow — intake must not fail because execute trigger failed
    });
    return { attempted: true, triggered: true, skippedReason: null };
  } catch {
    return { attempted: true, triggered: false, skippedReason: "trigger_failed" };
  }
}

export async function POST(req: NextRequest) {
  const auth = await checkAgentReadAuth(req);
  if (!auth.ok) {
    return unauthorizedAgentResponse(auth.error);
  }

  // Parse body
  let raw: IntakePayload;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  // Normalize & validate
  const normalized = normalizeIntakePayload(raw);
  if (!normalized.ok) {
    return NextResponse.json(
      { ok: false, error: normalized.error, field: normalized.field },
      { status: 400 },
    );
  }

  const { input, normalizedTaskType, normalizedSource } = normalized;

  // Duplicate detection — return deduped response instead of creating duplicate
  const duplicate = await findDuplicateManualTask(input.title, input.taskType);
  if (duplicate) {
    const counts = await countOpenExecutionReadyManualTasks().catch(() => ({
      openCount: 0, executionReadyCount: 0, inProgressCount: 0, blockedCount: 0, selectedCount: 0,
    }));

    return NextResponse.json({
      ok: true,
      created: false,
      deduped: true,
      duplicateMatchId: duplicate.id,
      normalizedTaskType,
      normalizedSource,
      task: duplicate,
      queueCounts: counts,
      autoExecute: {
        attempted: false,
        triggered: false,
        skippedReason: "deduped_existing_active_task",
      },
    });
  }

  // Create task via the shared manual queue
  const task = await createManualActionTask(input);
  if (!task) {
    return NextResponse.json(
      { ok: false, error: "Failed to create task (Redis unavailable)" },
      { status: 500 },
    );
  }

  const counts = await countOpenExecutionReadyManualTasks().catch(() => ({
    openCount: 0, executionReadyCount: 0, inProgressCount: 0, blockedCount: 0, selectedCount: 0,
  }));

  // Auto-trigger execution if conditions are met
  const autoExecute = await evaluateAutoExecute(task.executionReady);

  return NextResponse.json(
    {
      ok: true,
      created: true,
      deduped: false,
      normalizedTaskType,
      normalizedSource,
      task,
      queueCounts: counts,
      autoExecute,
    },
    { status: 201 },
  );
}
