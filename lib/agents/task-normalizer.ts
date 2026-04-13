/**
 * Task Normalizer — validates and normalizes intake payloads
 * into the ManualActionTaskInput shape used by the manual queue.
 */

import type {
  ManualActionPriority,
  ManualActionTaskType,
  ManualActionTaskInput,
  ManualActionSource,
} from "@/lib/agents/manual-action-queue";

// ─── Constants ──────────────────────────────────────────────────────

const VALID_PRIORITIES: ManualActionPriority[] = [
  "CRITICAL", "HIGH", "MEDIUM", "LOW",
];

const VALID_TASK_TYPES: ManualActionTaskType[] = [
  "BUGFIX", "BACKLOG", "OPTIMIZATION", "SELF_HEAL", "OPS",
  "SCORING", "SCANNER", "AUTO_ENTRY", "OTHER",
];

// ─── Raw intake payload shape ───────────────────────────────────────

export interface IntakePayload {
  title?: unknown;
  description?: unknown;
  priority?: unknown;
  taskType?: unknown;
  executionReady?: unknown;
  acceptanceCriteria?: unknown;
  fileHints?: unknown;
  routeHints?: unknown;
  source?: unknown;
  objective?: unknown;
  createdBy?: unknown;
}

export interface NormalizedIntakeResult {
  ok: true;
  input: ManualActionTaskInput;
  normalizedTaskType: ManualActionTaskType;
  normalizedSource: ManualActionSource;
}

export interface IntakeValidationError {
  ok: false;
  error: string;
  field?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

function trimStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function toStringArray(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(trimStr).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

// ─── Main normalizer ────────────────────────────────────────────────

export function normalizeIntakePayload(
  raw: IntakePayload,
): NormalizedIntakeResult | IntakeValidationError {
  // Title
  const title = trimStr(raw.title);
  if (!title) {
    return { ok: false, error: "Missing required field: title", field: "title" };
  }

  // Description
  const description = trimStr(raw.description);
  if (!description) {
    return { ok: false, error: "Missing required field: description", field: "description" };
  }

  // Priority
  const rawPriority = trimStr(raw.priority).toUpperCase() as ManualActionPriority;
  if (!VALID_PRIORITIES.includes(rawPriority)) {
    return {
      ok: false,
      error: `Invalid priority "${trimStr(raw.priority)}". Must be one of: ${VALID_PRIORITIES.join(", ")}`,
      field: "priority",
    };
  }

  // TaskType
  const rawTaskType = trimStr(raw.taskType).toUpperCase().replace(/-/g, "_") as ManualActionTaskType;
  if (!VALID_TASK_TYPES.includes(rawTaskType)) {
    return {
      ok: false,
      error: `Invalid taskType "${trimStr(raw.taskType)}". Must be one of: ${VALID_TASK_TYPES.join(", ")}`,
      field: "taskType",
    };
  }

  // Source
  const normalizedSource: ManualActionSource = trimStr(raw.source) || "chat_intake";

  // ExecutionReady
  const executionReady = raw.executionReady === true || raw.executionReady === "true";

  // Arrays
  const acceptanceCriteria = toStringArray(raw.acceptanceCriteria);
  const fileHints = toStringArray(raw.fileHints);
  const routeHints = toStringArray(raw.routeHints);

  // Optional fields
  const objective = trimStr(raw.objective) || undefined;
  const createdBy = trimStr(raw.createdBy) || undefined;

  const input: ManualActionTaskInput = {
    title,
    description,
    priority: rawPriority,
    taskType: rawTaskType,
    executionReady,
    source: normalizedSource,
    ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
    ...(fileHints.length > 0 ? { fileHints } : {}),
    ...(routeHints.length > 0 ? { routeHints } : {}),
    ...(objective ? { objective } : {}),
    ...(createdBy ? { createdBy } : {}),
  };

  return {
    ok: true,
    input,
    normalizedTaskType: rawTaskType,
    normalizedSource,
  };
}
