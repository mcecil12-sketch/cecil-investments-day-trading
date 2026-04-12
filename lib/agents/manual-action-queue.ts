import { redis } from "@/lib/redis";
import { AGENT_MANUAL_QUEUE_KEY } from "@/lib/agents/keys";
import { randomUUID } from "crypto";

// ─── Types ────────────────────────────────────────────────────────────

export type ManualActionPriority = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export type ManualActionTaskType =
  | "BUGFIX"
  | "BACKLOG"
  | "OPTIMIZATION"
  | "SELF_HEAL"
  | "OPS"
  | "SCORING"
  | "SCANNER"
  | "AUTO_ENTRY"
  | "OTHER";

export type ManualActionStatus =
  | "OPEN"
  | "SELECTED"
  | "IN_PROGRESS"
  | "BLOCKED"
  | "DONE"
  | "FAILED"
  | "CANCELED";

export interface ManualActionExecutionResult {
  ok: boolean;
  summary?: string;
  commitSha?: string | null;
  verification?: Record<string, unknown>;
  error?: string | null;
  finishedAt?: string;
}

export interface ManualActionTask {
  id: string;
  title: string;
  description: string;
  objective?: string;
  priority: ManualActionPriority;
  taskType: ManualActionTaskType;
  source: "manual_queue";
  executionReady: boolean;
  status: ManualActionStatus;
  acceptanceCriteria?: string[];
  fileHints?: string[];
  routeHints?: string[];
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  selectedAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  failedAt?: string | null;
  blockedReason?: string | null;
  latestExecutionResult?: ManualActionExecutionResult | null;
}

export type ManualActionTaskInput = Pick<
  ManualActionTask,
  "title" | "description" | "priority" | "taskType"
> &
  Partial<
    Pick<
      ManualActionTask,
      | "objective"
      | "executionReady"
      | "acceptanceCriteria"
      | "fileHints"
      | "routeHints"
      | "createdBy"
    >
  >;

export type ManualActionTaskPatch = Partial<
  Pick<
    ManualActionTask,
    | "status"
    | "priority"
    | "executionReady"
    | "blockedReason"
    | "acceptanceCriteria"
    | "fileHints"
    | "routeHints"
    | "latestExecutionResult"
  >
>;

export interface ListManualActionTasksOptions {
  status?: ManualActionStatus;
  executionReady?: boolean;
  limit?: number;
}

// ─── Priority ranking ─────────────────────────────────────────────────

const PRIORITY_RANK: Record<ManualActionPriority, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

function sortTasks(tasks: ManualActionTask[]): ManualActionTask[] {
  return tasks.sort((a, b) => {
    const pr = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (pr !== 0) return pr;
    return (a.createdAt || "").localeCompare(b.createdAt || "");
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────

async function getAllTasks(): Promise<ManualActionTask[]> {
  if (!redis) return [];
  const all = await redis.hgetall<Record<string, ManualActionTask>>(AGENT_MANUAL_QUEUE_KEY);
  if (!all) return [];
  return Object.values(all).filter(Boolean) as ManualActionTask[];
}

async function saveTask(task: ManualActionTask): Promise<void> {
  if (!redis) return;
  await redis.hset(AGENT_MANUAL_QUEUE_KEY, { [task.id]: task });
}

// ─── Public API ───────────────────────────────────────────────────────

export async function createManualActionTask(
  input: ManualActionTaskInput,
): Promise<ManualActionTask | null> {
  if (!redis) return null;
  const now = new Date().toISOString();
  const task: ManualActionTask = {
    id: randomUUID(),
    title: input.title,
    description: input.description,
    objective: input.objective,
    priority: input.priority,
    taskType: input.taskType,
    source: "manual_queue",
    executionReady: input.executionReady ?? false,
    status: "OPEN",
    acceptanceCriteria: input.acceptanceCriteria,
    fileHints: input.fileHints,
    routeHints: input.routeHints,
    createdAt: now,
    updatedAt: now,
    createdBy: input.createdBy,
    selectedAt: null,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    blockedReason: null,
    latestExecutionResult: null,
  };
  await saveTask(task);
  return task;
}

export async function listManualActionTasks(
  options?: ListManualActionTasksOptions,
): Promise<ManualActionTask[]> {
  let tasks = await getAllTasks();

  if (options?.status) {
    tasks = tasks.filter((t) => t.status === options.status);
  }
  if (options?.executionReady !== undefined) {
    tasks = tasks.filter((t) => t.executionReady === options.executionReady);
  }

  tasks = sortTasks(tasks);

  if (options?.limit && options.limit > 0) {
    tasks = tasks.slice(0, options.limit);
  }

  return tasks;
}

export async function getManualActionTask(
  id: string,
): Promise<ManualActionTask | null> {
  if (!redis) return null;
  const task = await redis.hget<ManualActionTask>(AGENT_MANUAL_QUEUE_KEY, id);
  return task ?? null;
}

export async function updateManualActionTask(
  id: string,
  patch: ManualActionTaskPatch,
): Promise<ManualActionTask | null> {
  const task = await getManualActionTask(id);
  if (!task) return null;
  const updated: ManualActionTask = {
    ...task,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await saveTask(updated);
  return updated;
}

/** Peek at the next execution-ready OPEN task without mutating state. */
export async function peekNextManualActionTask(): Promise<ManualActionTask | null> {
  const open = await listManualActionTasks({
    status: "OPEN",
    executionReady: true,
  });
  return open.length > 0 ? open[0] : null;
}

/** Claim the next OPEN execution-ready task: OPEN -> SELECTED */
export async function claimNextManualActionTask(): Promise<ManualActionTask | null> {
  const open = await listManualActionTasks({
    status: "OPEN",
    executionReady: true,
  });
  if (open.length === 0) return null;
  const task = open[0];
  const now = new Date().toISOString();
  const claimed: ManualActionTask = {
    ...task,
    status: "SELECTED",
    selectedAt: now,
    updatedAt: now,
  };
  await saveTask(claimed);
  return claimed;
}

/** Claim a specific task by id: OPEN -> SELECTED */
export async function claimManualActionTask(
  id: string,
): Promise<ManualActionTask | null> {
  const task = await getManualActionTask(id);
  if (!task || task.status !== "OPEN") return null;
  const now = new Date().toISOString();
  const claimed: ManualActionTask = {
    ...task,
    status: "SELECTED",
    selectedAt: now,
    updatedAt: now,
  };
  await saveTask(claimed);
  return claimed;
}

/** Start a claimed task: SELECTED -> IN_PROGRESS */
export async function startManualActionTask(
  id: string,
): Promise<ManualActionTask | null> {
  const task = await getManualActionTask(id);
  if (!task || task.status !== "SELECTED") return null;
  const now = new Date().toISOString();
  const started: ManualActionTask = {
    ...task,
    status: "IN_PROGRESS",
    startedAt: now,
    updatedAt: now,
  };
  await saveTask(started);
  return started;
}

/** Complete a task successfully: IN_PROGRESS -> DONE */
export async function completeManualActionTask(
  id: string,
  result: ManualActionExecutionResult,
): Promise<ManualActionTask | null> {
  const task = await getManualActionTask(id);
  if (!task) return null;
  const now = new Date().toISOString();
  const completed: ManualActionTask = {
    ...task,
    status: "DONE",
    completedAt: now,
    updatedAt: now,
    latestExecutionResult: { ...result, finishedAt: now },
  };
  await saveTask(completed);
  return completed;
}

/** Block a task: IN_PROGRESS | SELECTED -> BLOCKED */
export async function blockManualActionTask(
  id: string,
  reason: string,
  result?: ManualActionExecutionResult,
): Promise<ManualActionTask | null> {
  const task = await getManualActionTask(id);
  if (!task) return null;
  const now = new Date().toISOString();
  const blocked: ManualActionTask = {
    ...task,
    status: "BLOCKED",
    blockedReason: reason,
    updatedAt: now,
    latestExecutionResult: result
      ? { ...result, finishedAt: now }
      : task.latestExecutionResult,
  };
  await saveTask(blocked);
  return blocked;
}

/** Release a claimed/selected task back to OPEN: SELECTED -> OPEN */
export async function releaseManualActionTask(
  id: string,
  reason?: string,
): Promise<ManualActionTask | null> {
  const task = await getManualActionTask(id);
  if (!task || task.status !== "SELECTED") return null;
  const now = new Date().toISOString();
  const released: ManualActionTask = {
    ...task,
    status: "OPEN",
    selectedAt: null,
    updatedAt: now,
    blockedReason: reason ?? task.blockedReason,
  };
  await saveTask(released);
  return released;
}

/** @deprecated Use completeManualActionTask instead */
export async function resolveManualActionTask(
  id: string,
  result: ManualActionExecutionResult,
): Promise<ManualActionTask | null> {
  return completeManualActionTask(id, result);
}

/** Fail a task: IN_PROGRESS -> FAILED */
export async function failManualActionTask(
  id: string,
  result: ManualActionExecutionResult,
): Promise<ManualActionTask | null> {
  const task = await getManualActionTask(id);
  if (!task) return null;
  const now = new Date().toISOString();
  const failed: ManualActionTask = {
    ...task,
    status: "FAILED",
    failedAt: now,
    updatedAt: now,
    latestExecutionResult: { ...result, finishedAt: now },
  };
  await saveTask(failed);
  return failed;
}

export async function cancelManualActionTask(
  id: string,
  reason?: string,
): Promise<ManualActionTask | null> {
  const task = await getManualActionTask(id);
  if (!task) return null;
  const now = new Date().toISOString();
  const canceled: ManualActionTask = {
    ...task,
    status: "CANCELED",
    updatedAt: now,
    blockedReason: reason ?? task.blockedReason,
  };
  await saveTask(canceled);
  return canceled;
}

export async function countOpenExecutionReadyManualTasks(): Promise<{
  openCount: number;
  executionReadyCount: number;
  inProgressCount: number;
  blockedCount: number;
  selectedCount: number;
}> {
  const tasks = await getAllTasks();
  const active = tasks.filter(
    (t) => t.status !== "DONE" && t.status !== "FAILED" && t.status !== "CANCELED",
  );
  return {
    openCount: active.filter((t) => t.status === "OPEN" || t.status === "SELECTED" || t.status === "IN_PROGRESS").length,
    executionReadyCount: active.filter((t) => t.executionReady && (t.status === "OPEN" || t.status === "SELECTED")).length,
    inProgressCount: active.filter((t) => t.status === "IN_PROGRESS").length,
    blockedCount: active.filter((t) => t.status === "BLOCKED").length,
    selectedCount: active.filter((t) => t.status === "SELECTED").length,
  };
}

// ─── Stale Task Recovery ──────────────────────────────────────────────

const STALE_IN_PROGRESS_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const STALE_SELECTED_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export interface StaleRecoveryResult {
  recoveredCount: number;
  recovered: Array<{ id: string; title: string; previousStatus: ManualActionStatus; reason: string }>;
}

/** Recover stale IN_PROGRESS and SELECTED tasks that have exceeded timeout thresholds. */
export async function recoverStaleManualTasks(): Promise<StaleRecoveryResult> {
  const tasks = await getAllTasks();
  const now = Date.now();
  const recovered: StaleRecoveryResult["recovered"] = [];

  for (const task of tasks) {
    if (task.status === "IN_PROGRESS" && task.startedAt) {
      const startedMs = new Date(task.startedAt).getTime();
      if (now - startedMs > STALE_IN_PROGRESS_TIMEOUT_MS) {
        await failManualActionTask(task.id, {
          ok: false,
          summary: `Stale recovery: IN_PROGRESS for ${Math.round((now - startedMs) / 60000)}m without completion`,
          error: "stale_in_progress_timeout",
        });
        recovered.push({
          id: task.id,
          title: task.title,
          previousStatus: "IN_PROGRESS",
          reason: `stale_timeout_${Math.round((now - startedMs) / 60000)}m`,
        });
      }
    } else if (task.status === "SELECTED" && task.selectedAt) {
      const selectedMs = new Date(task.selectedAt).getTime();
      if (now - selectedMs > STALE_SELECTED_TIMEOUT_MS) {
        // Release back to OPEN so it can be re-claimed
        await releaseManualActionTask(task.id, "stale_selected_timeout");
        recovered.push({
          id: task.id,
          title: task.title,
          previousStatus: "SELECTED",
          reason: `stale_selected_timeout_${Math.round((now - selectedMs) / 60000)}m`,
        });
      }
    }
  }

  return { recoveredCount: recovered.length, recovered };
}

// ─── Duplicate Detection ──────────────────────────────────────────────

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

/** Check if a duplicate OPEN or IN_PROGRESS task exists with the same normalized title and taskType. */
export async function findDuplicateManualTask(
  title: string,
  taskType: ManualActionTask["taskType"],
): Promise<ManualActionTask | null> {
  const tasks = await getAllTasks();
  const normalizedInput = normalizeTitle(title);
  const activeStatuses: ManualActionStatus[] = ["OPEN", "SELECTED", "IN_PROGRESS"];

  return tasks.find(
    (t) =>
      activeStatuses.includes(t.status) &&
      t.taskType === taskType &&
      normalizeTitle(t.title) === normalizedInput,
  ) ?? null;
}

/** Check if any active manual task (OPEN/SELECTED/IN_PROGRESS) exists and is execution-relevant. */
export async function getActiveManualTask(): Promise<ManualActionTask | null> {
  const tasks = await getAllTasks();
  const active = tasks
    .filter((t) => t.status === "IN_PROGRESS" || t.status === "SELECTED" || (t.status === "OPEN" && t.executionReady))
    .sort((a, b) => {
      // IN_PROGRESS first, then SELECTED, then OPEN
      const statusRank: Record<string, number> = { IN_PROGRESS: 0, SELECTED: 1, OPEN: 2 };
      return (statusRank[a.status] ?? 3) - (statusRank[b.status] ?? 3);
    });
  return active[0] ?? null;
}
