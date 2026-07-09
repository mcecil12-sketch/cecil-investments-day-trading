/**
 * Conversational Task Parser
 *
 * Parses messages that begin with "Execute the following task:" into
 * structured IntakePayload objects compatible with the chat-intake flow.
 *
 * Supported fields (case-insensitive):
 *   Title, Type, Priority, Execute, Description,
 *   Acceptance Criteria, File Hints, Route Hints
 *
 * Acceptance Criteria, File Hints, and Route Hints may be multi-line
 * bullet lists (lines starting with - or *).
 */

import type { IntakePayload } from "./task-normalizer";

// ─── Trigger detection ──────────────────────────────────────────────

const TRIGGER_RE = /^execute the following task:\s*/i;

export function isConversationalTask(message: string): boolean {
  return TRIGGER_RE.test(message.trim());
}

// ─── Known field keys (lowercase) ───────────────────────────────────

const SINGLE_LINE_FIELDS = new Set([
  "title",
  "type",
  "priority",
  "execute",
  "description",
]);

const MULTI_LINE_FIELDS = new Set([
  "acceptance criteria",
  "file hints",
  "route hints",
]);

const ALL_FIELDS = new Set([...SINGLE_LINE_FIELDS, ...MULTI_LINE_FIELDS]);

// ─── Parser result ──────────────────────────────────────────────────

export interface ConversationalParseResult {
  ok: true;
  payload: IntakePayload;
  executeFlag: boolean;
}

export interface ConversationalParseError {
  ok: false;
  error: string;
}

// ─── Helpers ────────────────────────────────────────────────────────

function stripBullet(line: string): string {
  return line.replace(/^\s*[-*]\s*/, "").trim();
}

function fieldKeyFromLine(line: string): string | null {
  const match = line.match(/^([A-Za-z][A-Za-z ]*?):\s*/);
  if (!match) return null;
  const key = match[1].trim().toLowerCase();
  return ALL_FIELDS.has(key) ? key : null;
}

// ─── Main parser ────────────────────────────────────────────────────

export function parseConversationalTask(
  message: string,
): ConversationalParseResult | ConversationalParseError {
  const trimmed = message.trim();
  if (!TRIGGER_RE.test(trimmed)) {
    return { ok: false, error: "Message does not start with trigger phrase" };
  }

  // Strip trigger phrase
  const body = trimmed.replace(TRIGGER_RE, "").trim();
  if (!body) {
    return { ok: false, error: "Empty task payload after trigger phrase" };
  }

  const lines = body.split(/\r?\n/);

  // Accumulate field values
  const fields: Record<string, string[]> = {};
  let currentField: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // Blank lines — skip but don't reset current field
    if (line.trim() === "") continue;

    // Check if this line starts a new field
    const fieldKey = fieldKeyFromLine(line);
    if (fieldKey) {
      currentField = fieldKey;
      // Extract inline value after "Key: value"
      const colonIdx = line.indexOf(":");
      const inlineValue = line.slice(colonIdx + 1).trim();
      if (!fields[fieldKey]) fields[fieldKey] = [];
      if (inlineValue) {
        fields[fieldKey].push(inlineValue);
      }
      continue;
    }

    // Bullet line or continuation under current field
    if (currentField && MULTI_LINE_FIELDS.has(currentField)) {
      const stripped = stripBullet(line);
      if (stripped) {
        fields[currentField].push(stripped);
      }
      continue;
    }

    // Continuation of description field only.
    if (currentField === "description") {
      fields[currentField].push(line.trim());
      continue;
    }

    // If we have already parsed fields and encounter freeform text,
    // treat it as implicit description content.
    if (currentField && SINGLE_LINE_FIELDS.has(currentField)) {
      if (!fields["description"]) fields["description"] = [];
      fields["description"].push(line.trim());
      currentField = "description";
      continue;
    }

    // Unrecognized line before any field — ignore safely
  }

  // ── Extract individual fields with defaults ──

  const title = (fields["title"] ?? []).join(" ").trim();
  if (!title) {
    return { ok: false, error: "Missing required field: Title" };
  }

  const description = (fields["description"] ?? []).join("\n").trim();
  if (!description) {
    return { ok: false, error: "Missing required field: Description" };
  }

  // Type defaults to OPS
  const rawType = (fields["type"] ?? []).join("").trim().toUpperCase().replace(/-/g, "_") || "OPS";

  // Priority defaults to MEDIUM
  const rawPriority = (fields["priority"] ?? []).join("").trim().toUpperCase() || "MEDIUM";

  // Execute defaults to false
  const rawExecute = (fields["execute"] ?? []).join("").trim().toLowerCase();
  const executeFlag = rawExecute === "true" || rawExecute === "yes" || rawExecute === "1";

  // Multi-line arrays
  const acceptanceCriteria = fields["acceptance criteria"] ?? [];
  const fileHints = fields["file hints"] ?? [];
  const routeHints = fields["route hints"] ?? [];

  const payload: IntakePayload = {
    title,
    description,
    priority: rawPriority,
    taskType: rawType,
    executionReady: executeFlag,
    source: "chat_intake",
    ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
    ...(fileHints.length > 0 ? { fileHints } : {}),
    ...(routeHints.length > 0 ? { routeHints } : {}),
  };

  return { ok: true, payload, executeFlag };
}
