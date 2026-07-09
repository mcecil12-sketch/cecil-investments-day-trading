import { describe, expect, it, vi } from "vitest";
import { executeGithubTask } from "@/lib/agents/githubExecutor";

describe("githubExecutor", () => {
  it("writes patch artifact to repository contents API", async () => {
    const writeRepoFileImpl = vi.fn(async ({ path }) => ({
      path,
      commitSha: "abc123",
      commitUrl: "https://github.com/org/repo/commit/abc123",
    }));

    process.env.GITHUB_REPO_OWNER = "org";
    process.env.GITHUB_REPO_NAME = "repo";
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_INSTALLATION_ID = "456";
    process.env.GITHUB_APP_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----\\nabc\\n-----END RSA PRIVATE KEY-----";

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
        writeRepoFileImpl,
      },
    );

    expect(writeRepoFileImpl).toHaveBeenCalledTimes(1);
    expect(writeRepoFileImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "org",
        repo: "repo",
        path: "agent-patches/task-123.md",
        message: "agent: task",
        branch: "main",
      }),
    );
    const payload = writeRepoFileImpl.mock.calls[0][0];
    expect(payload.content).toContain("## Summary");
    expect(payload.content).toContain("summary");
    expect(payload.content).toContain("## Copilot Prompt");
    expect(payload.content).toContain("apply deterministic update");
    expect(payload.content).toContain("## Patch Plan Summary");
    expect(payload.content).toContain("## Validation Plan");
    expect(payload.content).toContain("## Commit Plan");

    expect(result).toEqual({
      success: true,
      commitMessage: "agent: task",
      filesTouched: ["agent-patches/task-123.md"],
      commitSha: "abc123",
      commitUrl: "https://github.com/org/repo/commit/abc123",
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
        patchPlan: {
          mode: "GITHUB_COMMIT",
          targetFiles: ["lib/a.ts"],
          proposedChangesSummary: "summary",
        },
      }),
    ).rejects.toThrow("missing_commit_plan");
  });
});
