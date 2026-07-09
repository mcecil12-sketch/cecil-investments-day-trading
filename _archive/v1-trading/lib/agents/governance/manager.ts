import type { EngineeringTask } from "@/lib/agents/types";

const BLOCKED_PATTERNS = [
  /rm\s+-rf/i,
  /drop\s+table/i,
  /truncate/i,
  /git\s+reset\s+--hard/i,
  /git\s+push\s+--force/i,
];

export function approveExecution(task: EngineeringTask) {
  if (!task) return { ok: false as const, reason: "missing_task" };
  if (task.status !== "OPEN") {
    return { ok: false as const, reason: "task_not_open" };
  }

  const prompt = [task.copilotPrompt, task.gitBlock, task.smokeTestBlock, ...(task.notes ?? [])]
    .filter(Boolean)
    .join("\n");

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(prompt)) {
      return { ok: false as const, reason: "blocked_pattern_detected" };
    }
  }

  return { ok: true as const };
}