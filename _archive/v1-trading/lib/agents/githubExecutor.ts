import { getGithubAppConfig } from "@/lib/agents/github/auth";
import { writeRepoFile, type WriteRepoFileResult } from "@/lib/agents/github/contents";
import type { EngineeringTask } from "@/lib/agents/types";

export interface GithubExecutionResult {
  success: boolean;
  commitMessage: string;
  filesTouched: string[];
  commitSha?: string;
  commitUrl?: string;
}

export interface GithubExecutorDeps {
  writeRepoFileImpl?: (input: {
    owner?: string;
    repo?: string;
    path: string;
    message: string;
    content: string;
    branch: string;
    sha?: string;
  }) => Promise<WriteRepoFileResult>;
}

function ensureExecutableTask(task: EngineeringTask): void {
  if (!task.patchPlan) {
    throw new Error("missing_patch_plan");
  }
  if (!task.commitPlan) {
    throw new Error("missing_commit_plan");
  }
  if (!task.commitPlan.commitMessage?.trim()) {
    throw new Error("missing_commit_message");
  }
}

function buildPatchNote(task: EngineeringTask): string {
  const summary = task.patchPlan?.proposedChangesSummary ?? "No summary provided.";
  const validationSummary = task.validationPlan
    ? [
        `- buildRequired: ${task.validationPlan.buildRequired ? "true" : "false"}`,
        `- testCommands: ${task.validationPlan.testCommands.length > 0 ? task.validationPlan.testCommands.join(" | ") : "(none)"}`,
        `- smokeChecks: ${task.validationPlan.smokeChecks.length > 0 ? task.validationPlan.smokeChecks.join(" | ") : "(none)"}`,
      ].join("\n")
    : "- (missing validation plan)";
  const commitSummary = task.commitPlan
    ? [
        `- commitMessage: ${task.commitPlan.commitMessage}`,
        `- targetBranch: ${task.commitPlan.targetBranch}`,
        `- pushDirect: ${task.commitPlan.pushDirect ? "true" : "false"}`,
      ].join("\n")
    : "- (missing commit plan)";
  const targetFiles = (task.patchPlan?.targetFiles ?? []).length > 0
    ? (task.patchPlan?.targetFiles ?? []).map((file) => `- ${file}`).join("\n")
    : "- (none)";

  return [
    `# Agent Patch ${task.id}`,
    "",
    `## Title`,
    task.title,
    "",
    `## Summary`,
    task.summary,
    "",
    `## Copilot Prompt`,
    task.copilotPrompt || "(empty)",
    "",
    `## Patch Plan Summary`,
    summary,
    "",
    `## Patch Targets`,
    targetFiles,
    "",
    `## Validation Plan`,
    validationSummary,
    "",
    `## Commit Plan`,
    commitSummary,
    "",
    `## Generated At`,
    new Date().toISOString(),
    "",
  ].join("\n");
}

export async function executeGithubTask(
  task: EngineeringTask,
  deps: GithubExecutorDeps = {},
): Promise<GithubExecutionResult> {
  ensureExecutableTask(task);

  const commitMessage = task.commitPlan!.commitMessage.trim();
  const patchPath = `agent-patches/${task.id}.md`;
  const config = getGithubAppConfig();
  const writer = deps.writeRepoFileImpl ?? writeRepoFile;
  const writeResult = await writer({
    owner: config.repoOwner,
    repo: config.repoName,
    path: patchPath,
    message: commitMessage,
    content: buildPatchNote(task),
    branch: task.commitPlan!.targetBranch,
  });

  return {
    success: true,
    commitMessage,
    filesTouched: [writeResult.path || patchPath],
    commitSha: writeResult.commitSha,
    commitUrl: writeResult.commitUrl,
  };
}