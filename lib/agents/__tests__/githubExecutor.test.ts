import { describe, expect, it, vi } from "vitest";
import { executeGithubTask } from "@/lib/agents/githubExecutor";

describe("githubExecutor", () => {
  it("creates patch file and runs git add/commit/push", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runCommand = vi.fn(async (command: string, args: string[]) => {
      calls.push({ command, args });
      return { stdout: "", stderr: "" };
    });
    const mkdir = vi.fn(async () => {});
    const writes: Array<{ path: string; content: string }> = [];
    const writeFile = vi.fn(async (path: string, content: string) => {
      writes.push({ path, content });
    });

    const result = await executeGithubTask(
      {
        id: "task-123",
        createdAt: "2026-04-05T10:00:00Z",
        updatedAt: "2026-04-05T10:00:00Z",
        status: "READY_FOR_EXECUTION",
        title: "Execute task",
        summary: "summary",
        likelyFiles: ["lib/a.ts"],
        copilotPrompt: "apply deterministic update",
        smokeTestBlock: "",
        gitBlock: "",
        patchPlan: {
          mode: "GITHUB_COMMIT",
          targetFiles: ["lib/a.ts"],
          proposedChangesSummary: "summary",
        },
        commitPlan: {
          commitMessage: "agent: task",
          targetBranch: "main",
          pushDirect: true,
        },
      },
      {
        cwd: "/repo",
        runCommand: runCommand as any,
        mkdir,
        writeFile,
      },
    );

    expect(mkdir).toHaveBeenCalledWith("/repo/agent-patches");
    expect(writes[0].path).toBe("/repo/agent-patches/task-123.md");
    expect(writes[0].content).toContain("Execute task");
    expect(writes[0].content).toContain("apply deterministic update");
    expect(calls).toEqual([
      { command: "git", args: ["add", "-A"] },
      { command: "git", args: ["commit", "-m", "agent: task"] },
      { command: "git", args: ["push"] },
    ]);
    expect(result).toEqual({
      success: true,
      commitMessage: "agent: task",
      filesTouched: ["agent-patches/task-123.md"],
    });
  });

  it("fails validation when commit plan is missing", async () => {
    await expect(
      executeGithubTask({
        id: "task-123",
        createdAt: "2026-04-05T10:00:00Z",
        updatedAt: "2026-04-05T10:00:00Z",
        status: "READY_FOR_EXECUTION",
        title: "Execute task",
        summary: "summary",
        likelyFiles: ["lib/a.ts"],
        copilotPrompt: "apply deterministic update",
        smokeTestBlock: "",
        gitBlock: "",
      }),
    ).rejects.toThrow("missing_commit_plan");
  });
});
