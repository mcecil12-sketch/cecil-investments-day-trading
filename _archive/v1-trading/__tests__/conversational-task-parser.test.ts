import { describe, it, expect } from "vitest";
import {
  isConversationalTask,
  parseConversationalTask,
} from "@/lib/agents/conversational-task-parser";

// ─── Trigger detection ──────────────────────────────────────────────

describe("isConversationalTask", () => {
  it("detects the trigger phrase (exact)", () => {
    expect(isConversationalTask("Execute the following task: something")).toBe(true);
  });

  it("detects with leading whitespace", () => {
    expect(isConversationalTask("  Execute the following task: foo")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isConversationalTask("EXECUTE THE FOLLOWING TASK: bar")).toBe(true);
    expect(isConversationalTask("execute the following task: baz")).toBe(true);
  });

  it("rejects non-matching messages", () => {
    expect(isConversationalTask("Please create a task")).toBe(false);
    expect(isConversationalTask("")).toBe(false);
  });
});

// ─── Full parsing ───────────────────────────────────────────────────

describe("parseConversationalTask", () => {
  it("parses a complete payload with all fields", () => {
    const msg = `Execute the following task:
Title: Fix scoring weights
Type: BUGFIX
Priority: HIGH
Execute: true
Description: The scoring weights are miscalibrated after the last deploy.
Acceptance Criteria:
- Weight for momentum should be 0.35
- Threshold should be 70
File Hints:
- lib/scoring/weights.ts
- lib/scoring/thresholds.ts
Route Hints:
- /api/scoring/tune`;

    const result = parseConversationalTask(msg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.payload.title).toBe("Fix scoring weights");
    expect(result.payload.taskType).toBe("BUGFIX");
    expect(result.payload.priority).toBe("HIGH");
    expect(result.payload.executionReady).toBe(true);
    expect(result.payload.description).toBe(
      "The scoring weights are miscalibrated after the last deploy."
    );
    expect(result.payload.acceptanceCriteria).toEqual([
      "Weight for momentum should be 0.35",
      "Threshold should be 70",
    ]);
    expect(result.payload.fileHints).toEqual([
      "lib/scoring/weights.ts",
      "lib/scoring/thresholds.ts",
    ]);
    expect(result.payload.routeHints).toEqual(["/api/scoring/tune"]);
    expect(result.executeFlag).toBe(true);
    expect(result.payload.source).toBe("chat_intake");
  });

  it("applies defaults: Type=OPS, Priority=MEDIUM, Execute=false", () => {
    const msg = `Execute the following task:
Title: Run health check
Description: Check all subsystems for degradation.`;

    const result = parseConversationalTask(msg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.payload.taskType).toBe("OPS");
    expect(result.payload.priority).toBe("MEDIUM");
    expect(result.payload.executionReady).toBe(false);
    expect(result.executeFlag).toBe(false);
  });

  it("handles Execute: yes as truthy", () => {
    const msg = `Execute the following task:
Title: Quick fix
Description: Fix it now
Execute: yes`;

    const result = parseConversationalTask(msg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.executeFlag).toBe(true);
    expect(result.payload.executionReady).toBe(true);
  });

  it("returns error for missing Title", () => {
    const msg = `Execute the following task:
Description: No title provided`;

    const result = parseConversationalTask(msg);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Title");
  });

  it("returns error for missing Description", () => {
    const msg = `Execute the following task:
Title: No description`;

    const result = parseConversationalTask(msg);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Description");
  });

  it("returns error when message lacks trigger phrase", () => {
    const result = parseConversationalTask("Please do something");
    expect(result.ok).toBe(false);
  });

  it("returns error for empty body after trigger", () => {
    const result = parseConversationalTask("Execute the following task:   ");
    expect(result.ok).toBe(false);
  });

  it("ignores unrecognized headings safely", () => {
    const msg = `Execute the following task:
Title: Do stuff
Description: Something important
Notes: This is extra info that shouldnt break parsing
Priority: LOW`;

    const result = parseConversationalTask(msg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.title).toBe("Do stuff");
    expect(result.payload.priority).toBe("LOW");
  });

  it("handles bullet lists with * prefix", () => {
    const msg = `Execute the following task:
Title: Bullet test
Description: Test star bullets
File Hints:
* lib/a.ts
* lib/b.ts`;

    const result = parseConversationalTask(msg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.fileHints).toEqual(["lib/a.ts", "lib/b.ts"]);
  });

  it("trims blank lines between fields", () => {
    const msg = `Execute the following task:

Title: Trim test

Description: Blank lines everywhere

Priority: HIGH

`;

    const result = parseConversationalTask(msg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.title).toBe("Trim test");
    expect(result.payload.priority).toBe("HIGH");
  });

  it("handles multi-line description", () => {
    const msg = `Execute the following task:
Title: Multi-line desc
Description: First line of description
second line of description
third line of description
Priority: LOW`;

    const result = parseConversationalTask(msg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.description).toBe(
      "First line of description\nsecond line of description\nthird line of description"
    );
  });

  it("normalizes type with hyphens to underscores", () => {
    const msg = `Execute the following task:
Title: Hyphen type
Type: auto-entry
Description: Testing type normalization`;

    const result = parseConversationalTask(msg);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.taskType).toBe("AUTO_ENTRY");
  });
});
