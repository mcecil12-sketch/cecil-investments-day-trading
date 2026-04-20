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

export type ManualActionSource = "manual_queue" | "chat_intake" | (string & {});

export interface ManualActionTask {
  id: string;
  title: string;
  description: string;
  objective?: string;
  priority: ManualActionPriority;
  taskType: ManualActionTaskType;
  source: ManualActionSource;
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
      | "source"
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
    source: input.source ?? "manual_queue",
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

export interface TaskSelectability {
  selectable: boolean;
  reason: string;
}

/** Compute why a task is or is not selectable right now. */
export function computeTaskSelectability(task: ManualActionTask): TaskSelectability {
  if (task.status === "DONE" || task.status === "FAILED" || task.status === "CANCELED") {
    return { selectable: false, reason: `terminal_status:${task.status}` };
  }
  if (task.status === "IN_PROGRESS") {
    return { selectable: false, reason: "already_in_progress" };
  }
  if (task.status === "SELECTED") {
    return { selectable: false, reason: "already_selected" };
  }
  if (task.status === "BLOCKED") {
    if (canRecoverBlockedTask(task)) {
      return { selectable: false, reason: "blocked_but_recoverable" };
    }
    return { selectable: false, reason: `blocked:${task.blockedReason || "unknown"}` };
  }
  if (task.status === "OPEN") {
    if (!task.executionReady) {
      return { selectable: false, reason: "not_execution_ready" };
    }
    return { selectable: true, reason: "open_and_execution_ready" };
  }
  return { selectable: false, reason: `unknown_status:${task.status}` };
}

export async function countOpenExecutionReadyManualTasks(): Promise<{
  openCount: number;
  executionReadyCount: number;
  inProgressCount: number;
  blockedCount: number;
  selectedCount: number;
  /** Tasks that can be selected right now (OPEN + executionReady, not blocked) */
  selectableCount: number;
  /** BLOCKED tasks that could potentially be recovered with fallback hints */
  recoverableBlockedCount: number;
  /** Why the queue has no selectable work (null if selectable work exists) */
  idleReason: string | null;
}> {
  const tasks = await getAllTasks();
  const active = tasks.filter(
    (t) => t.status !== "DONE" && t.status !== "FAILED" && t.status !== "CANCELED",
  );
  const blocked = active.filter((t) => t.status === "BLOCKED");
  const recoverableBlocked = blocked.filter(canRecoverBlockedTask);

  // Selectable = OPEN + executionReady (can be claimed immediately)
  const selectable = active.filter(
    (t) => t.status === "OPEN" && t.executionReady === true,
  );

  // Compute idle reason when nothing is selectable
  let idleReason: string | null = null;
  if (selectable.length === 0) {
    if (recoverableBlocked.length > 0) {
      idleReason = `${recoverableBlocked.length} blocked task(s) can be recovered with fallback hints — run recovery to promote`;
    } else if (blocked.length > 0) {
      idleReason = `${blocked.length} task(s) blocked with no recovery path available`;
    } else if (active.some((t) => t.status === "IN_PROGRESS")) {
      idleReason = "task already in progress";
    } else if (active.some((t) => t.status === "SELECTED")) {
      idleReason = "task already selected";
    } else if (active.length > 0 && active.every((t) => !t.executionReady)) {
      idleReason = "tasks exist but none are execution-ready";
    } else if (active.length === 0) {
      idleReason = "no active tasks in queue";
    }
  }

  return {
    openCount: active.filter((t) => t.status === "OPEN" || t.status === "SELECTED" || t.status === "IN_PROGRESS").length,
    executionReadyCount: active.filter((t) => t.executionReady && (t.status === "OPEN" || t.status === "SELECTED")).length,
    inProgressCount: active.filter((t) => t.status === "IN_PROGRESS").length,
    blockedCount: blocked.length,
    selectedCount: active.filter((t) => t.status === "SELECTED").length,
    selectableCount: selectable.length,
    recoverableBlockedCount: recoverableBlocked.length,
    idleReason,
  };
}

// ─── Stale Task Recovery ──────────────────────────────────────────────

const STALE_IN_PROGRESS_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const STALE_SELECTED_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export interface StaleRecoveryCandidate {
  id: string;
  title: string;
  previousStatus: ManualActionStatus;
  reasonCode: string;
  action: "failed" | "released";
}

export interface StaleRecoveryResult {
  attempted: boolean;
  recoveredCount: number;
  recovered: StaleRecoveryCandidate[];
  recoveredTaskIds: string[];
  failedTaskIds: string[];
  releasedTaskIds: string[];
  reasonCodes: string[];
}

function emptyStaleRecovery(): StaleRecoveryResult {
  return { attempted: false, recoveredCount: 0, recovered: [], recoveredTaskIds: [], failedTaskIds: [], releasedTaskIds: [], reasonCodes: [] };
}

/** Identify stale IN_PROGRESS and SELECTED tasks. Does not mutate state. */
export async function detectStaleManualTasks(): Promise<StaleRecoveryCandidate[]> {
  const tasks = await getAllTasks();
  const now = Date.now();
  const candidates: StaleRecoveryCandidate[] = [];

  for (const task of tasks) {
    if (task.status === "IN_PROGRESS") {
      // Case 1: startedAt is null — task was never properly started, always stale
      if (!task.startedAt) {
        // Fall back to selectedAt or updatedAt to compute age
        const refTime = task.selectedAt ?? task.updatedAt ?? task.createdAt;
        const ageMin = refTime ? Math.round((now - new Date(refTime).getTime()) / 60000) : 0;
        candidates.push({
          id: task.id,
          title: task.title,
          previousStatus: "IN_PROGRESS",
          reasonCode: `stale_in_progress_missing_startedAt_${ageMin}m`,
          action: "failed",
        });
        continue;
      }
      // Case 2: startedAt exists but exceeds timeout
      const startedMs = new Date(task.startedAt).getTime();
      if (now - startedMs > STALE_IN_PROGRESS_TIMEOUT_MS) {
        candidates.push({
          id: task.id,
          title: task.title,
          previousStatus: "IN_PROGRESS",
          reasonCode: `stale_in_progress_timeout_${Math.round((now - startedMs) / 60000)}m`,
          action: "failed",
        });
      }
    } else if (task.status === "SELECTED") {
      // Case 3: SELECTED exceeds timeout
      const refTime = task.selectedAt ?? task.updatedAt ?? task.createdAt;
      if (refTime) {
        const selectedMs = new Date(refTime).getTime();
        if (now - selectedMs > STALE_SELECTED_TIMEOUT_MS) {
          candidates.push({
            id: task.id,
            title: task.title,
            previousStatus: "SELECTED",
            reasonCode: `stale_selected_timeout_${Math.round((now - selectedMs) / 60000)}m`,
            action: "released",
          });
        }
      }
    }
  }
  return candidates;
}

/** Recover stale IN_PROGRESS and SELECTED tasks that have exceeded timeout thresholds.
 *  If dryRun=true, returns candidates without mutating state. */
export async function recoverStaleManualTasks(dryRun = false): Promise<StaleRecoveryResult> {
  const candidates = await detectStaleManualTasks();
  if (candidates.length === 0) return { ...emptyStaleRecovery(), attempted: true };

  if (dryRun) {
    return {
      attempted: true,
      recoveredCount: 0,
      recovered: candidates,
      recoveredTaskIds: [],
      failedTaskIds: candidates.filter((c) => c.action === "failed").map((c) => c.id),
      releasedTaskIds: candidates.filter((c) => c.action === "released").map((c) => c.id),
      reasonCodes: candidates.map((c) => c.reasonCode),
    };
  }

  const recovered: StaleRecoveryCandidate[] = [];
  const failedIds: string[] = [];
  const releasedIds: string[] = [];

  for (const candidate of candidates) {
    try {
      if (candidate.action === "failed") {
        await failManualActionTask(candidate.id, {
          ok: false,
          summary: `Stale recovery: ${candidate.reasonCode}`,
          error: candidate.reasonCode,
        });
        failedIds.push(candidate.id);
      } else {
        await releaseManualActionTask(candidate.id, candidate.reasonCode);
        releasedIds.push(candidate.id);
      }
      recovered.push(candidate);
    } catch (err) {
      console.warn(`[STALE-RECOVERY] Failed to recover task ${candidate.id}:`, err);
    }
  }

  return {
    attempted: true,
    recoveredCount: recovered.length,
    recovered,
    recoveredTaskIds: recovered.map((r) => r.id),
    failedTaskIds: failedIds,
    releasedTaskIds: releasedIds,
    reasonCodes: recovered.map((r) => r.reasonCode),
  };
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
  // Include BLOCKED to avoid duplicate spam — blocked tasks should be recovered, not re-created
  const activeStatuses: ManualActionStatus[] = ["OPEN", "SELECTED", "IN_PROGRESS", "BLOCKED"];

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

// ─── Failed/Blocked Task Cleanup ──────────────────────────────────────

const FAILED_TASK_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const BLOCKED_TASK_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours

export interface FailedTaskCleanupResult {
  attempted: boolean;
  totalFailed: number;
  totalBlocked: number;
  archivedCount: number;
  archivedTaskIds: string[];
}

/**
 * Cleanup old FAILED and BLOCKED tasks by marking them CANCELED.
 * This prevents the queue from filling up with unrecoverable tasks.
 * Does NOT mutate state in dryRun mode.
 */
export async function cleanupFailedTasks(dryRun = false): Promise<FailedTaskCleanupResult> {
  const tasks = await getAllTasks();
  const now = Date.now();
  
  const failedTasks = tasks.filter((t) => t.status === "FAILED");
  const blockedTasks = tasks.filter((t) => t.status === "BLOCKED");
  
  const failedCandidates = failedTasks.filter((t) => {
    const failedAt = t.failedAt ?? t.updatedAt ?? t.createdAt;
    if (!failedAt) return true; // No timestamp means definitely stale
    const ageMs = now - new Date(failedAt).getTime();
    return ageMs > FAILED_TASK_AGE_MS;
  });
  
  const blockedCandidates = blockedTasks.filter((t) => {
    const blockedAt = t.updatedAt ?? t.createdAt;
    if (!blockedAt) return true;
    const ageMs = now - new Date(blockedAt).getTime();
    return ageMs > BLOCKED_TASK_AGE_MS;
  });
  
  const candidates = [...failedCandidates, ...blockedCandidates];
  
  if (candidates.length === 0 || dryRun) {
    return {
      attempted: true,
      totalFailed: failedTasks.length,
      totalBlocked: blockedTasks.length,
      archivedCount: dryRun ? candidates.length : 0,
      archivedTaskIds: candidates.map((c) => c.id),
    };
  }
  
  const archivedIds: string[] = [];
  for (const task of candidates) {
    try {
      await cancelManualActionTask(task.id, `auto_archived_stale_${task.status.toLowerCase()}`);
      archivedIds.push(task.id);
    } catch (err) {
      console.warn(`[CLEANUP] Failed to archive task ${task.id}:`, err);
    }
  }
  
  return {
    attempted: true,
    totalFailed: failedTasks.length,
    totalBlocked: blockedTasks.length,
    archivedCount: archivedIds.length,
    archivedTaskIds: archivedIds,
  };
}

// ─── Blocked Task Recovery with Fallback Hints ────────────────────────

/**
 * Fallback hints by taskType. These are used to unblock tasks that were
 * created without fileHints or routeHints and got BLOCKED with no_file_hints.
 *
 * IMPORTANT: Keep in sync with INCIDENT_DEFAULTS in incident-task-bridge.ts
 */
const FALLBACK_HINTS_BY_TASK_TYPE: Record<ManualActionTaskType, { fileHints?: string[]; routeHints?: string[] }> = {
  OPS: {
    fileHints: [
      "app/api/trades/protection-audit/route.ts",
      "app/api/auto-entry/execute/route.ts",
      "lib/risk/protection-integrity.ts",
      "app/api/agents/queue/route.ts",
      "app/api/agents/state/route.ts",
      "app/api/agents/execute/route.ts",
      "lib/agents/manual-action-queue.ts",
    ],
    routeHints: [
      "/api/trades/protection-audit",
      "/api/broker/positions",
      "/api/trades?view=operational",
      "/api/agents/queue",
      "/api/agents/state",
      "/api/agents/execute",
    ],
  },
  SELF_HEAL: {
    fileHints: [
      "app/api/funnel-health/route.ts",
      "app/api/readiness/route.ts",
      "lib/autoEntry/guardrails.ts",
      "app/api/auto-entry/execute/route.ts",
      "app/api/trades/protection-audit/route.ts",
    ],
    routeHints: [
      "/api/funnel-health",
      "/api/readiness",
      "/api/auto-entry/seed-from-signals",
      "/api/auto-entry/execute",
      "/api/trades/protection-audit",
    ],
  },
  BUGFIX: {
    fileHints: [
      "app/api/funnel-health/route.ts",
      "lib/aiScoring.ts",
    ],
    routeHints: ["/api/readiness"],
  },
  SCORING: {
    fileHints: [
      "app/api/ai/score/drain/route.ts",
      "lib/aiScoring.ts",
      "app/api/signals/all/route.ts",
      "app/api/readiness/route.ts",
    ],
    routeHints: [
      "/api/ai/score/drain",
      "/api/signals/all",
      "/api/readiness",
    ],
  },
  SCANNER: {
    fileHints: [
      "app/api/signals/route.ts",
      "app/api/signals/all/route.ts",
    ],
    routeHints: [
      "/api/signals",
      "/api/signals/all",
    ],
  },
  AUTO_ENTRY: {
    fileHints: [
      "app/api/auto-entry/execute/route.ts",
      "app/api/auto-entry/seed-from-signals/route.ts",
      "lib/autoEntry/guardrails.ts",
    ],
    routeHints: [
      "/api/auto-entry/execute",
      "/api/auto-entry/seed-from-signals",
      "/api/funnel-health",
    ],
  },
  BACKLOG: {
    fileHints: [],
    routeHints: ["/api/readiness"],
  },
  OPTIMIZATION: {
    fileHints: [],
    routeHints: ["/api/readiness"],
  },
  OTHER: {
    fileHints: [],
    routeHints: ["/api/readiness", "/api/funnel-health"],
  },
};

export interface BlockedTaskRecoveryCandidate {
  id: string;
  title: string;
  taskType: ManualActionTaskType;
  blockedReason: string | null;
  action: "enriched_unblocked" | "enriched_still_blocked" | "already_has_hints" | "no_fallback_available";
  hintsApplied: boolean;
  fileHintsAdded?: string[];
  routeHintsAdded?: string[];
}

export interface BlockedTaskRecoveryResult {
  attempted: boolean;
  recoveredCount: number;
  enrichedCount: number;
  candidates: BlockedTaskRecoveryCandidate[];
  recoveredTaskIds: string[];
  enrichedTaskIds: string[];
  skippedTaskIds: string[];
}

/** Check if a BLOCKED task can be unblocked by applying fallback hints. */
export function canRecoverBlockedTask(task: ManualActionTask): boolean {
  if (task.status !== "BLOCKED") return false;

  const reason = task.blockedReason || "";
  // Only recover tasks blocked specifically for missing hints
  if (!reason.includes("no_file_hints") && !reason.includes("no_route_hints") && !reason.includes("no_execution_path")) {
    return false;
  }

  // Check if the task already has hints (shouldn't happen, but be safe)
  const hasFileHints = task.fileHints && task.fileHints.length > 0;
  const hasRouteHints = task.routeHints && task.routeHints.length > 0;
  if (hasFileHints || hasRouteHints) return false;

  // Check if we have fallback hints for this taskType
  const fallback = FALLBACK_HINTS_BY_TASK_TYPE[task.taskType];
  if (!fallback) return false;

  const hasFallbackFileHints = !!(fallback.fileHints && fallback.fileHints.length > 0);
  const hasFallbackRouteHints = !!(fallback.routeHints && fallback.routeHints.length > 0);

  return hasFallbackFileHints || hasFallbackRouteHints;
}

/**
 * Apply fallback hints to a BLOCKED task and unblock it if appropriate.
 * Returns the updated task or null if no changes were made.
 */
export async function enrichAndUnblockTask(
  taskId: string,
  dryRun = false,
): Promise<BlockedTaskRecoveryCandidate | null> {
  const task = await getManualActionTask(taskId);
  if (!task || task.status !== "BLOCKED") return null;

  const reason = task.blockedReason || "";
  const isHintBlocked =
    reason.includes("no_file_hints") ||
    reason.includes("no_route_hints") ||
    reason.includes("no_execution_path");

  // Already has hints — shouldn't be blocked for this reason
  const hasFileHints = task.fileHints && task.fileHints.length > 0;
  const hasRouteHints = task.routeHints && task.routeHints.length > 0;
  if (hasFileHints || hasRouteHints) {
    return {
      id: task.id,
      title: task.title,
      taskType: task.taskType,
      blockedReason: task.blockedReason ?? null,
      action: "already_has_hints",
      hintsApplied: false,
    };
  }

  // Get fallback hints
  const fallback = FALLBACK_HINTS_BY_TASK_TYPE[task.taskType];
  if (!fallback) {
    return {
      id: task.id,
      title: task.title,
      taskType: task.taskType,
      blockedReason: task.blockedReason ?? null,
      action: "no_fallback_available",
      hintsApplied: false,
    };
  }

  const fileHintsToAdd = fallback.fileHints && fallback.fileHints.length > 0 ? fallback.fileHints : [];
  const routeHintsToAdd = fallback.routeHints && fallback.routeHints.length > 0 ? fallback.routeHints : [];

  if (fileHintsToAdd.length === 0 && routeHintsToAdd.length === 0) {
    return {
      id: task.id,
      title: task.title,
      taskType: task.taskType,
      blockedReason: task.blockedReason ?? null,
      action: "no_fallback_available",
      hintsApplied: false,
    };
  }

  // Determine if we can unblock
  const canUnblock = isHintBlocked && (fileHintsToAdd.length > 0 || routeHintsToAdd.length > 0);

  if (!dryRun) {
    const patch: ManualActionTaskPatch = {
      fileHints: fileHintsToAdd.length > 0 ? fileHintsToAdd : task.fileHints,
      routeHints: routeHintsToAdd.length > 0 ? routeHintsToAdd : task.routeHints,
    };

    if (canUnblock) {
      patch.status = "OPEN";
      patch.blockedReason = null;
      patch.executionReady = true;
    }

    await updateManualActionTask(task.id, patch);
    console.log(`[BLOCKED_RECOVERY] ${canUnblock ? "Unblocked" : "Enriched"} task ${task.id}: added ${fileHintsToAdd.length} fileHints, ${routeHintsToAdd.length} routeHints`);
  }

  return {
    id: task.id,
    title: task.title,
    taskType: task.taskType,
    blockedReason: task.blockedReason ?? null,
    action: canUnblock ? "enriched_unblocked" : "enriched_still_blocked",
    hintsApplied: true,
    fileHintsAdded: fileHintsToAdd,
    routeHintsAdded: routeHintsToAdd,
  };
}

/**
 * Recover BLOCKED tasks by applying fallback hints based on taskType.
 * Runs BEFORE task selection in the execute loop to maximize available work.
 */
export async function recoverBlockedTasksWithFallbackHints(
  dryRun = false,
): Promise<BlockedTaskRecoveryResult> {
  const tasks = await getAllTasks();
  const blocked = tasks.filter((t) => t.status === "BLOCKED");

  if (blocked.length === 0) {
    return {
      attempted: true,
      recoveredCount: 0,
      enrichedCount: 0,
      candidates: [],
      recoveredTaskIds: [],
      enrichedTaskIds: [],
      skippedTaskIds: [],
    };
  }

  const candidates: BlockedTaskRecoveryCandidate[] = [];
  const recoveredIds: string[] = [];
  const enrichedIds: string[] = [];
  const skippedIds: string[] = [];

  for (const task of blocked) {
    const result = await enrichAndUnblockTask(task.id, dryRun);
    if (!result) {
      skippedIds.push(task.id);
      continue;
    }

    candidates.push(result);

    if (result.action === "enriched_unblocked") {
      recoveredIds.push(task.id);
      enrichedIds.push(task.id);
    } else if (result.action === "enriched_still_blocked") {
      enrichedIds.push(task.id);
    } else {
      skippedIds.push(task.id);
    }
  }

  if (recoveredIds.length > 0 || enrichedIds.length > 0) {
    console.log(`[BLOCKED_RECOVERY] Processed ${blocked.length} BLOCKED tasks: recovered=${recoveredIds.length} enriched=${enrichedIds.length} skipped=${skippedIds.length}`);
  }

  return {
    attempted: true,
    recoveredCount: recoveredIds.length,
    enrichedCount: enrichedIds.length,
    candidates,
    recoveredTaskIds: recoveredIds,
    enrichedTaskIds: enrichedIds,
    skippedTaskIds: skippedIds,
  };
}

/**
 * Get a summary of the manual task queue state for diagnostics.
 */
export async function getManualQueueDiagnostics(): Promise<{
  totalTasks: number;
  openCount: number;
  selectedCount: number;
  inProgressCount: number;
  blockedCount: number;
  failedCount: number;
  doneCount: number;
  canceledCount: number;
  executionReadyCount: number;
  staleTaskIds: string[];
  healthStatus: "healthy" | "degraded" | "blocked";
  healthReason: string | null;
}> {
  const tasks = await getAllTasks();
  
  const byStatus = {
    OPEN: tasks.filter((t) => t.status === "OPEN").length,
    SELECTED: tasks.filter((t) => t.status === "SELECTED").length,
    IN_PROGRESS: tasks.filter((t) => t.status === "IN_PROGRESS").length,
    BLOCKED: tasks.filter((t) => t.status === "BLOCKED").length,
    FAILED: tasks.filter((t) => t.status === "FAILED").length,
    DONE: tasks.filter((t) => t.status === "DONE").length,
    CANCELED: tasks.filter((t) => t.status === "CANCELED").length,
  };
  
  const executionReady = tasks.filter(
    (t) => t.executionReady && (t.status === "OPEN" || t.status === "SELECTED")
  ).length;
  
  // Detect stale tasks
  const staleCandidates = await detectStaleManualTasks();
  
  // Determine health status
  let healthStatus: "healthy" | "degraded" | "blocked" = "healthy";
  let healthReason: string | null = null;
  
  if (byStatus.BLOCKED > 5) {
    healthStatus = "blocked";
    healthReason = `${byStatus.BLOCKED} tasks are BLOCKED`;
  } else if (byStatus.FAILED > 10) {
    healthStatus = "degraded";
    healthReason = `${byStatus.FAILED} tasks have FAILED`;
  } else if (staleCandidates.length > 0) {
    healthStatus = "degraded";
    healthReason = `${staleCandidates.length} stale task(s) detected`;
  } else if (byStatus.IN_PROGRESS > 1) {
    healthStatus = "degraded";
    healthReason = `Multiple IN_PROGRESS tasks (${byStatus.IN_PROGRESS})`;
  }
  
  return {
    totalTasks: tasks.length,
    openCount: byStatus.OPEN,
    selectedCount: byStatus.SELECTED,
    inProgressCount: byStatus.IN_PROGRESS,
    blockedCount: byStatus.BLOCKED,
    failedCount: byStatus.FAILED,
    doneCount: byStatus.DONE,
    canceledCount: byStatus.CANCELED,
    executionReadyCount: executionReady,
    staleTaskIds: staleCandidates.map((c) => c.id),
    healthStatus,
    healthReason,
  };
}
