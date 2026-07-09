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

// ─── Title source tracking ──────────────────────────────────────────

export type TitleSource =
  | "top_level"
  | "message_title_line"
  | "first_message_line"
  | "generated";

// ─── Raw intake payload shape ───────────────────────────────────────

export interface IntakePayload {
  title?: unknown;
  name?: unknown;
  summary?: unknown;
  description?: unknown;
  message?: unknown;
  body?: unknown;
  prompt?: unknown;
  priority?: unknown;
  taskType?: unknown;
  type?: unknown;
  executionReady?: unknown;
  execute?: unknown;
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
  titleSource: TitleSource;
  acceptedFields: string[];
  missingFields: string[];
}

export interface IntakeValidationError {
  ok: false;
  error: string;
  field?: string;
  normalizedTitle?: string | null;
  titleSource?: TitleSource;
  acceptedFields?: string[];
  missingFields?: string[];
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

// ─── Title extraction from message text ─────────────────────────────

function extractTitleFromMessage(
  message: string,
): { title: string; source: TitleSource } | null {
  if (!message) return null;

  const lines = message.split(/\r?\n/);

  // Pattern 1: "Title: ..." or "Task: ..." on any line
  for (const line of lines) {
    const titleMatch = line.match(/^title:\s*(.+)$/i);
    if (titleMatch) {
      const t = titleMatch[1].trim();
      if (t) return { title: t.slice(0, 120), source: "message_title_line" };
    }
    const taskMatch = line.match(/^task:\s*(.+)$/i);
    if (taskMatch) {
      const t = taskMatch[1].trim();
      if (t) return { title: t.slice(0, 120), source: "message_title_line" };
    }
  }

  // Pattern 2: First non-empty line as fallback
  for (const line of lines) {
    const t = line.trim();
    if (t) return { title: t.slice(0, 120), source: "first_message_line" };
  }

  return null;
}

// ─── Short ID generation ─────────────────────────────────────────────

function shortId(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// ─── Main normalizer ────────────────────────────────────────────────

export function normalizeIntakePayload(
  raw: IntakePayload,
): NormalizedIntakeResult | IntakeValidationError {
  const allRawKeys = Object.keys(raw);
  const acceptedFields: string[] = [];
  const missingFields: string[] = [];

  // ── Title: try top-level aliases first ──────────────────────────
  let title = trimStr(raw.title) || trimStr(raw.name) || trimStr(raw.summary);
  let titleSource: TitleSource = "top_level";

  if (title) {
    const usedKey = trimStr(raw.title) ? "title" : trimStr(raw.name) ? "name" : "summary";
    acceptedFields.push(usedKey);
  } else {
    // Try to extract from message/description/body/prompt text
    const messageText =
      trimStr(raw.message) ||
      trimStr(raw.description) ||
      trimStr(raw.body) ||
      trimStr(raw.prompt);

    const extracted = messageText ? extractTitleFromMessage(messageText) : null;
    if (extracted) {
      title = extracted.title;
      titleSource = extracted.source;
    } else if (messageText) {
      // Message exists but no extractable title — generate
      title = `Untitled Agent Task ${shortId()}`;
      titleSource = "generated";
    } else {
      // Nothing at all — generate and flag as missing
      title = `Untitled Agent Task ${shortId()}`;
      titleSource = "generated";
      missingFields.push("title");
    }
  }

  // ── Description: try all text aliases ────────────────────────────
  const description =
    trimStr(raw.description) ||
    trimStr(raw.message) ||
    trimStr(raw.body) ||
    trimStr(raw.prompt);

  if (description) {
    const usedKey = trimStr(raw.description)
      ? "description"
      : trimStr(raw.message)
        ? "message"
        : trimStr(raw.body)
          ? "body"
          : "prompt";
    acceptedFields.push(usedKey);
  } else {
    missingFields.push("description");
    return {
      ok: false,
      error: "Missing required field: description (provide message, description, body, or prompt)",
      field: "description",
      normalizedTitle: title,
      titleSource,
      acceptedFields,
      missingFields,
    };
  }

  // ── Priority ──────────────────────────────────────────────────────
  const rawPriorityInput = trimStr(raw.priority).toUpperCase();
  const rawPriority = (rawPriorityInput || "MEDIUM") as ManualActionPriority;
  if (!VALID_PRIORITIES.includes(rawPriority)) {
    return {
      ok: false,
      error: `Invalid priority "${trimStr(raw.priority)}". Must be one of: ${VALID_PRIORITIES.join(", ")}`,
      field: "priority",
      normalizedTitle: title,
      titleSource,
      acceptedFields,
      missingFields,
    };
  }
  if (rawPriorityInput) acceptedFields.push("priority");

  // ── TaskType ──────────────────────────────────────────────────────
  const rawTypeInput = (trimStr(raw.taskType || raw.type) || "TASK").toUpperCase().replace(/-/g, "_");
  const rawTaskType = (
    rawTypeInput === "BUG" ? "BUGFIX" :
    rawTypeInput === "TASK" || rawTypeInput === "" ? "OTHER" :
    rawTypeInput
  ) as ManualActionTaskType;
  if (!VALID_TASK_TYPES.includes(rawTaskType)) {
    return {
      ok: false,
      error: `Invalid taskType/type "${trimStr(raw.taskType || raw.type)}". Must be one of: ${VALID_TASK_TYPES.join(", ")}`,
      field: "taskType",
      normalizedTitle: title,
      titleSource,
      acceptedFields,
      missingFields,
    };
  }
  if (trimStr(raw.taskType) || trimStr(raw.type)) {
    acceptedFields.push(trimStr(raw.taskType) ? "taskType" : "type");
  }

  // ── Source ────────────────────────────────────────────────────────
  const normalizedSource: ManualActionSource = trimStr(raw.source) || "chat_intake";

  // ── ExecutionReady: respect explicit flag, then infer from message ─
  const executeRaw = raw.executionReady ?? raw.execute;
  let executionReady = executeRaw === true || executeRaw === "true";

  if (!executionReady && executeRaw !== false && executeRaw !== "false") {
    // Try to infer from message text
    const msgLower = description.toLowerCase();
    if (/\bexecute\b/.test(msgLower) || /\brun now\b/.test(msgLower)) {
      executionReady = true;
    }
  }
  if (executeRaw !== undefined && executeRaw !== null) {
    acceptedFields.push("execute");
  }

  // ── Arrays ────────────────────────────────────────────────────────
  const acceptanceCriteria = toStringArray(raw.acceptanceCriteria);
  const fileHints = toStringArray(raw.fileHints);
  const routeHints = toStringArray(raw.routeHints);

  // ── Optional fields ───────────────────────────────────────────────
  const objective = trimStr(raw.objective) || undefined;
  const createdBy = trimStr(raw.createdBy) || undefined;

  // Record remaining accepted top-level keys
  for (const key of allRawKeys) {
    if (!acceptedFields.includes(key) && !missingFields.includes(key)) {
      if (["acceptanceCriteria", "fileHints", "routeHints", "source", "objective", "createdBy"].includes(key)) {
        acceptedFields.push(key);
      }
    }
  }

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
    titleSource,
    acceptedFields,
    missingFields,
  };
}
