import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listEngineeringTasks: vi.fn(),
  updateEngineeringTaskById: vi.fn(async () => undefined),
  prepareExecutionPlan: vi.fn(() => ({
    patchPlan: {
      mode: "GITHUB_COMMIT",
      targetFiles: ["app/api/agents/execute/route.ts"],
      proposedChangesSummary: "Enable orchestrated execution",
    },
    validationPlan: {
      buildRequired: true,
      testCommands: ["npm run test"],
      smokeChecks: ["GET /api/agents/engineering"],
    },
    commitPlan: {
      commitMessage: "agent: Enable GitHub API write access",
      targetBranch: "main",
      pushDirect: true,
    },
    executionStatus: "READY",
    nextTaskStatus: "READY_FOR_EXECUTION",
  })),
  approveExecution: vi.fn(() => ({ ok: true })),
  executeGithubTask: vi.fn(async () => ({
    success: true,
    commitMessage: "agent: execute task",
    filesTouched: ["agent-patches/task-ready.md"],
    commitSha: "abc123",
    commitUrl: "https://github.com/org/repo/commit/abc123",
  })),
}));

vi.mock("@/lib/agents/store", () => ({
  listEngineeringTasks: mocks.listEngineeringTasks,
  updateEngineeringTaskById: mocks.updateEngineeringTaskById,
}));

vi.mock("@/lib/agents/execution/engine", () => ({
  prepareExecutionPlan: mocks.prepareExecutionPlan,
}));

vi.mock("@/lib/agents/governance/manager", () => ({
  approveExecution: mocks.approveExecution,
}));

vi.mock("@/lib/agents/githubExecutor", () => ({
  executeGithubTask: mocks.executeGithubTask,
}));

import { POST } from "../route";

describe("POST /api/agents/execute", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_TOKEN = "test-cron-token";
    delete process.env.CRON_SECRET;
  });

  it("returns 401 without a valid x-cron-token", async () => {
    const response = await POST(
      new Request("http://localhost/api/agents/execute", {
        method: "POST",
      }) as any,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      ok: false,
      error: "unauthorized",
      message: "Missing or invalid x-cron-token",
    });
  });

  it("returns early when there is no open task", async () => {
    mocks.listEngineeringTasks.mockResolvedValueOnce([]);

    const response = await POST(
      new Request("http://localhost/api/agents/execute", {
        method: "POST",
        headers: { "x-cron-token": "test-cron-token" },
      }) as any,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, message: "No execution-ready tasks" });
    expect(mocks.updateEngineeringTaskById).not.toHaveBeenCalled();
  });

  it("returns no execution-ready tasks when only blocked or done tasks exist", async () => {
    mocks.listEngineeringTasks.mockResolvedValueOnce([
      {
        id: "task-blocked",
        createdAt: "2026-04-05T10:00:00Z",
        updatedAt: "2026-04-05T10:00:00Z",
        status: "BLOCKED",
        title: "Blocked task",
        summary: "summary",
        likelyFiles: [],
        copilotPrompt: "",
        smokeTestBlock: "",
        gitBlock: "",
      },
      {
        id: "task-done",
        createdAt: "2026-04-05T09:00:00Z",
        updatedAt: "2026-04-05T09:00:00Z",
        status: "DONE",
        title: "Done task",
        summary: "summary",
        likelyFiles: [],
        copilotPrompt: "",
        smokeTestBlock: "",
        gitBlock: "",
      },
    ]);

    const response = await POST(
      new Request("http://localhost/api/agents/execute", {
        method: "POST",
        headers: { "x-cron-token": "test-cron-token" },
      }) as any,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, message: "No execution-ready tasks" });
    expect(mocks.approveExecution).not.toHaveBeenCalled();
    expect(mocks.prepareExecutionPlan).not.toHaveBeenCalled();
    expect(mocks.updateEngineeringTaskById).not.toHaveBeenCalled();
  });

  it("blocks execution when governance rejects the task", async () => {
    mocks.listEngineeringTasks.mockResolvedValueOnce([
      {
        id: "task-1",
        createdAt: "2026-04-05T10:00:00Z",
        updatedAt: "2026-04-05T10:00:00Z",
        status: "OPEN",
        title: "Blocked task",
        summary: "summary",
        likelyFiles: ["lib/agents/governance/manager.ts"],
        copilotPrompt: "rm -rf /",
        smokeTestBlock: "",
        gitBlock: "",
      },
    ]);
    mocks.approveExecution.mockReturnValueOnce({ ok: false, reason: "blocked_pattern_detected" });

    const response = await POST(
      new Request("http://localhost/api/agents/execute", {
        method: "POST",
        headers: { "x-cron-token": "test-cron-token" },
      }) as any,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      reason: "blocked_pattern_detected",
      taskId: "task-1",
      executionStatus: "BLOCKED",
    });
    expect(mocks.prepareExecutionPlan).not.toHaveBeenCalled();
  });

  it("prefers READY_FOR_EXECUTION over OPEN and ignores blocked tasks", async () => {
    mocks.listEngineeringTasks.mockResolvedValueOnce([
      {
        id: "task-blocked",
        createdAt: "2026-04-05T11:00:00Z",
        updatedAt: "2026-04-05T11:00:00Z",
        status: "BLOCKED",
        title: "Blocked task",
        summary: "summary",
        likelyFiles: ["lib/a.ts"],
        copilotPrompt: "blocked",
        smokeTestBlock: "",
        gitBlock: "",
      },
      {
        id: "task-open",
        createdAt: "2026-04-05T10:00:00Z",
        updatedAt: "2026-04-05T10:00:00Z",
        status: "OPEN",
        title: "Open task",
        summary: "summary",
        likelyFiles: ["lib/b.ts"],
        copilotPrompt: "safe",
        smokeTestBlock: "",
        gitBlock: "",
      },
      {
        id: "task-ready",
        createdAt: "2026-04-05T09:00:00Z",
        updatedAt: "2026-04-05T09:00:00Z",
        status: "READY_FOR_EXECUTION",
        title: "Ready task",
        summary: "summary",
        likelyFiles: ["lib/c.ts"],
        copilotPrompt: "safe",
        smokeTestBlock: "",
        gitBlock: "",
        patchPlan: {
          mode: "GITHUB_COMMIT",
          targetFiles: ["lib/c.ts"],
          proposedChangesSummary: "summary",
        },
        commitPlan: {
          commitMessage: "agent: ready",
          targetBranch: "main",
          pushDirect: true,
        },
        executionStatus: "READY",
      },
    ]);

    const response = await POST(
      new Request("http://localhost/api/agents/execute", {
        method: "POST",
        headers: { "x-cron-token": "test-cron-token" },
      }) as any,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, executedTaskId: "task-ready", executionStatus: "EXECUTED" });
    expect(mocks.approveExecution).not.toHaveBeenCalled();
    expect(mocks.executeGithubTask).toHaveBeenCalledWith(expect.objectContaining({ id: "task-ready" }));
  });

  it("executes READY_FOR_EXECUTION tasks and marks them DONE", async () => {
    mocks.listEngineeringTasks.mockResolvedValueOnce([
      {
        id: "task-ready",
        createdAt: "2026-04-05T09:00:00Z",
        updatedAt: "2026-04-05T09:00:00Z",
        status: "READY_FOR_EXECUTION",
        title: "Ready task",
        summary: "summary",
        likelyFiles: ["lib/c.ts"],
        copilotPrompt: "safe",
        smokeTestBlock: "",
        gitBlock: "",
        patchPlan: {
          mode: "GITHUB_COMMIT",
          targetFiles: ["lib/c.ts"],
          proposedChangesSummary: "summary",
        },
        commitPlan: {
          commitMessage: "agent: ready",
          targetBranch: "main",
          pushDirect: true,
        },
        executionStatus: "READY",
      },
    ]);

    const response = await POST(
      new Request("http://localhost/api/agents/execute", {
        method: "POST",
        headers: { "x-cron-token": "test-cron-token" },
      }) as any,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      executedTaskId: "task-ready",
      executionStatus: "EXECUTED",
      commitMessage: "agent: execute task",
      commitSha: "abc123",
      commitUrl: "https://github.com/org/repo/commit/abc123",
    });
    expect(mocks.updateEngineeringTaskById).toHaveBeenCalledWith(
      "task-ready",
      expect.objectContaining({
        status: "DONE",
        executionStatus: "EXECUTED",
        remediationStatus: "completed",
        remediationResultSummary: expect.stringContaining("Executed via GitHub contents API"),
      }),
    );
  });

  it("skips READY_FOR_EXECUTION tasks that fail execution guardrails", async () => {
    mocks.listEngineeringTasks.mockResolvedValueOnce([
      {
        id: "task-ready",
        createdAt: "2026-04-05T09:00:00Z",
        updatedAt: "2026-04-05T09:00:00Z",
        status: "READY_FOR_EXECUTION",
        title: "Ready task",
        summary: "summary",
        likelyFiles: ["lib/c.ts"],
        copilotPrompt: "safe",
        smokeTestBlock: "",
        gitBlock: "",
        patchPlan: {
          mode: "FILE_WRITE",
          targetFiles: ["lib/c.ts"],
          proposedChangesSummary: "summary",
        },
        commitPlan: {
          commitMessage: "agent: ready",
          targetBranch: "main",
          pushDirect: true,
        },
        executionStatus: "READY",
      },
    ]);

    const response = await POST(
      new Request("http://localhost/api/agents/execute", {
        method: "POST",
        headers: { "x-cron-token": "test-cron-token" },
      }) as any,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      taskId: "task-ready",
      executionStatus: "READY",
      skipped: true,
      reason: "patch_mode_not_github_commit",
    });
    expect(mocks.executeGithubTask).not.toHaveBeenCalled();
  });

  it("marks task BLOCKED when github execution fails", async () => {
    mocks.listEngineeringTasks.mockResolvedValueOnce([
      {
        id: "task-ready",
        createdAt: "2026-04-05T09:00:00Z",
        updatedAt: "2026-04-05T09:00:00Z",
        status: "READY_FOR_EXECUTION",
        title: "Ready task",
        summary: "summary",
        likelyFiles: ["lib/c.ts"],
        copilotPrompt: "safe",
        smokeTestBlock: "",
        gitBlock: "",
        patchPlan: {
          mode: "GITHUB_COMMIT",
          targetFiles: ["lib/c.ts"],
          proposedChangesSummary: "summary",
        },
        commitPlan: {
          commitMessage: "agent: ready",
          targetBranch: "main",
          pushDirect: true,
        },
        executionStatus: "READY",
      },
    ]);
    mocks.executeGithubTask.mockRejectedValueOnce(new Error("push_failed"));

    const response = await POST(
      new Request("http://localhost/api/agents/execute", {
        method: "POST",
        headers: { "x-cron-token": "test-cron-token" },
      }) as any,
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      ok: false,
      taskId: "task-ready",
      executionStatus: "FAILED",
    });
    expect(mocks.updateEngineeringTaskById).toHaveBeenCalledWith(
      "task-ready",
      expect.objectContaining({
        status: "BLOCKED",
        executionStatus: "FAILED",
        executionError: "push_failed",
      }),
    );
  });

  it("prepares execution readiness and does not shell out", async () => {
    mocks.listEngineeringTasks.mockResolvedValueOnce([
      {
        id: "task-1",
        createdAt: "2026-04-05T10:00:00Z",
        updatedAt: "2026-04-05T10:00:00Z",
        status: "OPEN",
        title: "Enable GitHub API write access",
        summary: "summary",
        likelyFiles: ["app/api/agents/execute/route.ts"],
        copilotPrompt: "Add safe execution engine",
        smokeTestBlock: "curl /api/agents/execute",
        gitBlock: "git push",
        notes: ["seeded by engineering manager"],
      },
    ]);

    const response = await POST(
      new Request("http://localhost/api/agents/execute", {
        method: "POST",
        headers: { "x-cron-token": "test-cron-token" },
      }) as any,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      taskId: "task-1",
      executionStatus: "READY_FOR_EXECUTION",
      commitPlan: { targetBranch: "main", pushDirect: true },
      validationPlan: { buildRequired: true },
    });
    expect(mocks.prepareExecutionPlan).toHaveBeenCalledTimes(1);
    expect(mocks.prepareExecutionPlan).toHaveBeenCalledWith(expect.objectContaining({ id: "task-1" }));
    expect(mocks.updateEngineeringTaskById).toHaveBeenCalledTimes(1);
    expect(mocks.updateEngineeringTaskById).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "READY_FOR_EXECUTION",
        executionStatus: "READY",
        executionError: null,
      }),
    );
  });
});