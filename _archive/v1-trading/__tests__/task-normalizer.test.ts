import { describe, it, expect } from "vitest";
import { normalizeIntakePayload } from "@/lib/agents/task-normalizer";

// ─── Top-level title field ───────────────────────────────────────────

describe("title resolution — top_level", () => {
  it("accepts an explicit top-level title", () => {
    const result = normalizeIntakePayload({
      title: "Fix scoring weights",
      message: "Description of the fix",
      execute: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.title).toBe("Fix scoring weights");
    expect(result.titleSource).toBe("top_level");
  });

  it("accepts name as alias for title", () => {
    const result = normalizeIntakePayload({
      name: "Task via name field",
      description: "Some description",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.title).toBe("Task via name field");
    expect(result.titleSource).toBe("top_level");
  });

  it("accepts summary as alias for title", () => {
    const result = normalizeIntakePayload({
      summary: "Task via summary",
      message: "Details here",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.title).toBe("Task via summary");
    expect(result.titleSource).toBe("top_level");
  });
});

// ─── Title: line inside message ──────────────────────────────────────

describe("title resolution — message_title_line", () => {
  it("extracts title from Title: line in message (acceptance test)", () => {
    const result = normalizeIntakePayload({
      message:
        "Title: Fix last-mile autonomous agent execution\nAgents are READY but not burning down tasks.",
      execute: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.title).toBe("Fix last-mile autonomous agent execution");
    expect(result.titleSource).toBe("message_title_line");
    expect(result.input.executionReady).toBe(true);
  });

  it("extracts title from Title: line (case-insensitive)", () => {
    const result = normalizeIntakePayload({
      message: "TITLE: My Important Task\nThis is what needs to happen.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.title).toBe("My Important Task");
    expect(result.titleSource).toBe("message_title_line");
  });

  it("extracts title from Task: line", () => {
    const result = normalizeIntakePayload({
      message: "Task: Fix the broken scanner\nThe scanner is not running.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.title).toBe("Fix the broken scanner");
    expect(result.titleSource).toBe("message_title_line");
  });

  it("accepts body as alias for message", () => {
    const result = normalizeIntakePayload({
      body: "Title: Task from body field\nAll of this is the description.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.title).toBe("Task from body field");
    expect(result.titleSource).toBe("message_title_line");
  });

  it("accepts prompt as alias for message", () => {
    const result = normalizeIntakePayload({
      prompt: "Title: Task from prompt\nDescription goes here.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.title).toBe("Task from prompt");
    expect(result.titleSource).toBe("message_title_line");
  });
});

// ─── First-line fallback ─────────────────────────────────────────────

describe("title resolution — first_message_line", () => {
  it("uses first non-empty message line when no Title: prefix", () => {
    const result = normalizeIntakePayload({
      message: "Run the daily health check\nThis covers all subsystems.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.title).toBe("Run the daily health check");
    expect(result.titleSource).toBe("first_message_line");
  });

  it("truncates first line to 120 characters", () => {
    const longLine = "A".repeat(200);
    const result = normalizeIntakePayload({
      message: `${longLine}\nDescription`,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.title.length).toBe(120);
    expect(result.titleSource).toBe("first_message_line");
  });

  it("skips leading blank lines when finding first non-empty line", () => {
    const result = normalizeIntakePayload({
      message: "\n\nActual first line\nMore content here.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.title).toBe("Actual first line");
    expect(result.titleSource).toBe("first_message_line");
  });
});

// ─── Generated fallback ──────────────────────────────────────────────

describe("title resolution — generated", () => {
  it("generates title when no message and no title fields provided", () => {
    // This will also fail description validation, so we need a description
    const result = normalizeIntakePayload({
      description: "Fallback description without a title",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.title).toMatch(/^Untitled Agent Task [A-Z0-9]+$/);
    expect(result.titleSource).toBe("generated");
  });
});

// ─── No rejection when message exists ───────────────────────────────

describe("no rejection when message exists", () => {
  it("does not reject when execute=true but title is in message", () => {
    const result = normalizeIntakePayload({
      message: "Title: Autonomous agent fix\nDescription of what to fix.",
      execute: true,
    });
    expect(result.ok).toBe(true);
  });

  it("does not reject when only message is provided", () => {
    const result = normalizeIntakePayload({
      message: "Fix the broker connection, the API is returning 400 errors.",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects only when there is truly no content at all", () => {
    const result = normalizeIntakePayload({});
    // With no message, description, body, prompt — description is still missing
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.field).toBe("description");
  });
});

// ─── Execute defaults ────────────────────────────────────────────────

describe("execute defaults", () => {
  it("keeps execute=true when explicitly set", () => {
    const result = normalizeIntakePayload({
      message: "Title: Task\nRun this task ASAP.",
      execute: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.executionReady).toBe(true);
  });

  it("infers execute=true when message contains 'execute'", () => {
    const result = normalizeIntakePayload({
      message: "Title: Task\nPlease execute this task now.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.executionReady).toBe(true);
  });

  it("infers execute=true when message contains 'run now'", () => {
    const result = normalizeIntakePayload({
      message: "Title: Task\nRun now, it is urgent.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.executionReady).toBe(true);
  });

  it("defaults execute=false when no execute signals present", () => {
    const result = normalizeIntakePayload({
      message: "Title: Task\nThis is a normal queued task.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.executionReady).toBe(false);
  });
});

// ─── Diagnostics in response ─────────────────────────────────────────

describe("diagnostics", () => {
  it("includes titleSource, acceptedFields, missingFields on success", () => {
    const result = normalizeIntakePayload({
      title: "My task",
      message: "Do the thing.",
      priority: "HIGH",
      execute: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.titleSource).toBe("top_level");
    expect(result.acceptedFields).toContain("title");
    expect(result.acceptedFields).toContain("execute");
    expect(result.missingFields).toEqual([]);
  });

  it("includes diagnostics on validation errors too", () => {
    const result = normalizeIntakePayload({
      message: "Title: Valid title\nBut priority is wrong.",
      priority: "SUPER_HIGH",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.normalizedTitle).toBe("Valid title");
    expect(result.titleSource).toBe("message_title_line");
    expect(result.field).toBe("priority");
  });
});

// ─── Payload variant aliases ─────────────────────────────────────────

describe("payload variant normalization", () => {
  it("accepts type as alias for taskType", () => {
    const result = normalizeIntakePayload({
      message: "Title: Task\nDo the thing.",
      type: "BUGFIX",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.taskType).toBe("BUGFIX");
  });

  it("maps BUG → BUGFIX", () => {
    const result = normalizeIntakePayload({
      message: "Title: Task\nDo the thing.",
      taskType: "BUG",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.taskType).toBe("BUGFIX");
  });

  it("maps TASK → OTHER", () => {
    const result = normalizeIntakePayload({
      message: "Title: Task\nDo the thing.",
      taskType: "TASK",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.taskType).toBe("OTHER");
  });
});
