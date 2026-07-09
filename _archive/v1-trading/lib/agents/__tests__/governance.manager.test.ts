import { describe, expect, it } from "vitest";

import { approveExecution } from "@/lib/agents/governance/manager";

describe("approveExecution", () => {
  it("approves a normal open task", () => {
    expect(
      approveExecution({
        id: "task-1",
        createdAt: "2026-04-05T10:00:00Z",
        updatedAt: "2026-04-05T10:00:00Z",
        status: "OPEN",
        title: "Normal task",
        summary: "summary",
        likelyFiles: ["lib/agents/execution/engine.ts"],
        copilotPrompt: "Implement a safe execution engine",
        smokeTestBlock: "npm run test",
        gitBlock: "git add -A && git commit -m \"phase 2d\"",
      }),
    ).toEqual({ ok: true });
  });

  it("rejects blocked shell patterns", () => {
    expect(
      approveExecution({
        id: "task-1",
        createdAt: "2026-04-05T10:00:00Z",
        updatedAt: "2026-04-05T10:00:00Z",
        status: "OPEN",
        title: "Dangerous task",
        summary: "summary",
        likelyFiles: ["/"],
        copilotPrompt: "Please rm -rf /tmp/data",
        smokeTestBlock: "",
        gitBlock: "",
      }),
    ).toEqual({ ok: false, reason: "blocked_pattern_detected" });
  });

  it("rejects tasks that are not open", () => {
    expect(
      approveExecution({
        id: "task-1",
        createdAt: "2026-04-05T10:00:00Z",
        updatedAt: "2026-04-05T10:00:00Z",
        status: "IN_PROGRESS",
        title: "Already running",
        summary: "summary",
        likelyFiles: ["lib/agents/store.ts"],
        copilotPrompt: "continue work",
        smokeTestBlock: "",
        gitBlock: "",
      }),
    ).toEqual({ ok: false, reason: "task_not_open" });
  });
});