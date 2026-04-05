import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { EngineeringTask } from "@/lib/agents/types";

const execFileAsync = promisify(execFile);

type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string },
) => Promise<{ stdout: string; stderr: string }>;

type WriteFileFn = (path: string, content: string) => Promise<void>;
type MkdirFn = (path: string) => Promise<void>;

export interface GithubExecutionResult {
  success: boolean;
  commitMessage: string;
  filesTouched: string[];
}

export interface GithubExecutorDeps {
  cwd?: string;
  runCommand?: CommandRunner;
  writeFile?: WriteFileFn;
  mkdir?: MkdirFn;
}

function defaultRunCommand(
  command: string,
  args: string[],
  options: { cwd: string },
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, options);
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
  const targetFiles = (task.patchPlan?.targetFiles ?? []).length > 0
    ? (task.patchPlan?.targetFiles ?? []).map((file) => `- ${file}`).join("\n")
    : "- (none)";

  return [
    `# Agent Patch ${task.id}`,
    "",
    `## Title`,
    task.title,
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

  const cwd = deps.cwd ?? process.cwd();
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const writeFileImpl = deps.writeFile ?? (async (path: string, content: string) => {
    await writeFile(path, content, "utf8");
  });
  const mkdirImpl = deps.mkdir ?? (async (path: string) => {
    await mkdir(path, { recursive: true });
  });

  const patchDir = join(cwd, "agent-patches");
  const patchFile = join(patchDir, `${task.id}.md`);
  await mkdirImpl(patchDir);
  await writeFileImpl(patchFile, buildPatchNote(task));

  const commitMessage = task.commitPlan!.commitMessage.trim();
  await runCommand("git", ["add", "-A"], { cwd });
  await runCommand("git", ["commit", "-m", commitMessage], { cwd });
  await runCommand("git", ["push"], { cwd });

  return {
    success: true,
    commitMessage,
    filesTouched: [relative(cwd, patchFile)],
  };
}