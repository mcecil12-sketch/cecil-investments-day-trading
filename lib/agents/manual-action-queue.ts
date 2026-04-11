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

export async function resolveManualActionTask(
  id: string,
  result: ManualActionExecutionResult,
): Promise<ManualActionTask | null> {
  const task = await getManualActionTask(id);
  if (!task) return null;
  const now = new Date().toISOString();
  const resolved: ManualActionTask = {
    ...task,
    status: "DONE",
    completedAt: now,
    updatedAt: now,
    latestExecutionResult: { ...result, finishedAt: now },
  };
  await saveTask(resolved);
  return resolved;
}

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
  };
}
