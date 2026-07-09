/**
 * Chat Intake Bridge — allows in-process task creation from GPT chat
 * without HTTP round-trips or curl commands.
 *
 * Usage:
 *   import { createTaskFromChat } from "@/lib/agents/chat-intake";
 *   const result = await createTaskFromChat({ title, description, priority, taskType });
 */

import {
  createManualActionTask,
  findDuplicateManualTask,
  countOpenExecutionReadyManualTasks,
  getActiveManualTask,
  type ManualActionTaskInput,
  type ManualActionPriority,
  type ManualActionTaskType,
} from "@/lib/agents/manual-action-queue";

// ─── Input shape ────────────────────────────────────────────────────

export interface ChatTaskInput {
  title: string;
  description: string;
  priority: ManualActionPriority;
  taskType: ManualActionTaskType;
  executionReady?: boolean;
  acceptanceCriteria?: string[];
  fileHints?: string[];
  routeHints?: string[];
  objective?: string;
}

// ─── Result shape ───────────────────────────────────────────────────

export interface ChatIntakeResult {
  created: boolean;
  deduped: boolean;
  taskId: string | null;
  executionTriggered: boolean;
  reason?: string;
}

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

async function triggerExecutor(): Promise<boolean> {
  try {
    const base = resolveBaseUrl();
    const headers = buildInternalHeaders();
    // Fire and forget — don't await the full response
    fetch(`${base}/api/agents/execute`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {
      // Swallow — chat intake must not fail because execute trigger failed
    });
    return true;
  } catch {
    return false;
  }
}

// ─── Main entry point ───────────────────────────────────────────────

export async function createTaskFromChat(input: ChatTaskInput): Promise<ChatIntakeResult> {
  // Dedupe check
  const duplicate = await findDuplicateManualTask(input.title, input.taskType);
  if (duplicate) {
    return {
      created: false,
      deduped: true,
      taskId: duplicate.id,
      executionTriggered: false,
      reason: `Duplicate of existing task ${duplicate.id} (${duplicate.status})`,
    };
  }

  // Build task input
  const taskInput: ManualActionTaskInput = {
    title: input.title,
    description: input.description,
    priority: input.priority,
    taskType: input.taskType,
    executionReady: input.executionReady ?? false,
    source: "chat_gpt",
    ...(input.acceptanceCriteria?.length ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
    ...(input.fileHints?.length ? { fileHints: input.fileHints } : {}),
    ...(input.routeHints?.length ? { routeHints: input.routeHints } : {}),
    ...(input.objective ? { objective: input.objective } : {}),
  };

  // Create task directly (no HTTP round-trip)
  const task = await createManualActionTask(taskInput);
  if (!task) {
    return {
      created: false,
      deduped: false,
      taskId: null,
      executionTriggered: false,
      reason: "Failed to create task (Redis unavailable)",
    };
  }

  // Auto-execute if conditions met
  let executionTriggered = false;
  if (task.executionReady) {
    try {
      const active = await getActiveManualTask();
      const counts = await countOpenExecutionReadyManualTasks();

      if (!active && counts.inProgressCount === 0) {
        executionTriggered = await triggerExecutor();
      }
    } catch {
      // non-fatal — task was created successfully regardless
    }
  }

  return {
    created: true,
    deduped: false,
    taskId: task.id,
    executionTriggered,
  };
}
