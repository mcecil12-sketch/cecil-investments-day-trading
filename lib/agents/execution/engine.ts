import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

type ExecutionResult =
  | { ok: true; skipped?: boolean; reason?: string }
  | { ok: false; error: string };

function runCommand(command: string, args: string[]) {
  execFileSync(command, args, {
    cwd: process.cwd(),
    stdio: "pipe",
    encoding: "utf8",
  });
}

function extractMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export async function runPatchExecution(patch: string): Promise<ExecutionResult> {
  const normalizedPatch = patch.trim();
  if (!normalizedPatch) {
    return { ok: true, skipped: true, reason: "empty_patch" };
  }

  const tempDir = mkdtempSync(join(tmpdir(), "agent-exec-"));
  const patchPath = join(tempDir, "agent_patch.diff");

  try {
    writeFileSync(patchPath, `${normalizedPatch}\n`, "utf8");
    runCommand("git", ["apply", "--check", patchPath]);
    runCommand("git", ["apply", patchPath]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: extractMessage(error) };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function runBuildAndTests(): Promise<ExecutionResult> {
  try {
    runCommand("npm", ["run", "build"]);
    runCommand("npm", ["run", "test"]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: extractMessage(error) };
  }
}

export async function commitAndPush(message: string): Promise<ExecutionResult> {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: process.cwd(),
      stdio: "pipe",
      encoding: "utf8",
    }).trim();

    if (branch !== "main") {
      return { ok: false, error: `not_on_main_branch:${branch}` };
    }

    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: process.cwd(),
      stdio: "pipe",
      encoding: "utf8",
    }).trim();

    if (!status) {
      return { ok: true, skipped: true, reason: "no_changes" };
    }

    runCommand("git", ["add", "-A"]);
    runCommand("git", ["commit", "-m", message]);
    runCommand("git", ["push", "origin", "HEAD:main"]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: extractMessage(error) };
  }
}