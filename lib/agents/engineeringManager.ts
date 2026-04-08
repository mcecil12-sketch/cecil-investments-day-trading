/**
 * Engineering Manager Orchestrator — Phase 3
 *
 * The EM is the control layer between strategic insights and autonomous
 * execution. It gathers performance learning, strategist guidance, and the
 * current task queue, then scores and selects the highest-value next task.
 *
 * Role hierarchy served:
 *   Strategy layer : Portfolio Manager, Risk Manager, News/Policy Strategist,
 *                    Performance Agent
 *   Execution layer: Engineering Manager (this module), Engineering Agent,
 *                    QA/Validation Agent, Orchestrator
 */

import { redis } from "@/lib/redis";
import { getTtlSeconds, setWithTtl } from "@/lib/redis/ttl";
import { getOpenBacklogItems, listEngineeringTasks } from "@/lib/agents/store";
import { nowIso } from "@/lib/agents/time";
import { getStrategistBrief } from "@/lib/agents/newsStrategist";
import { computePerformanceLearning, readPerformanceLearning } from "@/lib/agents/performanceLearning";
import { scoreAndRank } from "@/lib/agents/taskPriority";
import { AGENT_EM_BRIEF_KEY } from "@/lib/agents/keys";
import type {
  EngineeringManagerBrief,
  PerformanceLearningSignals,
  ScoredTask,
  StrategistBrief,
} from "@/lib/agents/types";

const STORE_TTL = getTtlSeconds("TELEMETRY_DAYS");

// ─── Brief persistence ────────────────────────────────────────────────────────

async function writeEmBrief(brief: EngineeringManagerBrief): Promise<void> {
  if (!redis) return;
  try {
    await setWithTtl(redis, AGENT_EM_BRIEF_KEY, JSON.stringify(brief), STORE_TTL);
  } catch {
    // non-fatal
  }
}

export async function readEmBrief(): Promise<EngineeringManagerBrief | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get<string>(AGENT_EM_BRIEF_KEY);
    if (!raw) return null;
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === "object" && "scoredTasks" in parsed) {
      return parsed as EngineeringManagerBrief;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Learning summary helper ──────────────────────────────────────────────────

function summarizeLearning(learning: PerformanceLearningSignals): string {
  if (learning.totalTrades === 0) return "No recent trade data available.";
  const parts: string[] = [
    `${learning.totalTrades} trades (${ANALYSIS_WINDOW}d): win ${(learning.winRate * 100).toFixed(0)}%, avgR ${learning.avgR.toFixed(2)}`,
  ];
  if (learning.deepLossRate > 0.1) {
    parts.push(`deep losses ${(learning.deepLossRate * 100).toFixed(0)}% ⚠`);
  }
  if (learning.longVsShortImbalance !== "balanced") {
    parts.push(learning.longVsShortImbalance);
  }
  if (learning.recommendedCorrections.length > 0) {
    parts.push(`corrections: ${learning.recommendedCorrections[0]}`);
  }
  return parts.join(" | ");
}

const ANALYSIS_WINDOW = 30;

// ─── Public API ───────────────────────────────────────────────────────────────

export interface EmOrchestrationResult {
  brief: EngineeringManagerBrief;
  scoredTasks: ScoredTask[];
  selectedTaskId: string | null;
  selectedTaskTitle: string | null;
  strategist: StrategistBrief;
  learning: PerformanceLearningSignals;
}

/**
 * Run the Engineering Manager orchestration pass.
 *
 * 1. Refresh performance learning signals
 * 2. Get current strategist brief
 * 3. Score all eligible tasks and backlog items
 * 4. Select the top-ranked eligible task
 * 5. Persist the EM brief
 */
export async function runEmOrchestration(): Promise<EmOrchestrationResult> {
  const now = nowIso();

  // Parallel fetches for context
  const [
    storedLearning,
    strategist,
    engineeringTasks,
    backlogItems,
  ] = await Promise.all([
    readPerformanceLearning(),
    getStrategistBrief(),
    listEngineeringTasks(100),
    getOpenBacklogItems(100),
  ]);

  // Recompute learning if stale (>1 hour old) or missing
  let learning: PerformanceLearningSignals;
  if (
    !storedLearning ||
    Date.now() - new Date(storedLearning.computedAt).getTime() > 60 * 60 * 1000
  ) {
    learning = await computePerformanceLearning();
  } else {
    learning = storedLearning;
  }

  // Build scoring inputs from eligible tasks and backlog
  const eligibleTasks = engineeringTasks.filter(
    (t) => t.status === "OPEN" || t.status === "READY_FOR_EXECUTION" || t.status === "IN_PROGRESS",
  );

  const inputs = [
    ...eligibleTasks.map((task) => ({ kind: "task" as const, task })),
    ...backlogItems.map((item) => ({ kind: "backlog" as const, item })),
  ];

  const scoredTasks = scoreAndRank(inputs, learning, strategist);

  // Select the top-ranked engineering task (not just backlog item)
  const topTask = scoredTasks.find((st) =>
    eligibleTasks.some((t) => t.id === st.taskId),
  );

  const selectedTaskId = topTask?.taskId ?? null;
  const selectedTaskTitle = topTask?.title ?? null;

  const rationale = topTask
    ? `Selected "${topTask.title}" — ${topTask.rationale}. Strategist bias: ${strategist.marketBias}.`
    : `No eligible engineering tasks. ${scoredTasks.length} items scored.`;

  const brief: EngineeringManagerBrief = {
    id: crypto.randomUUID(),
    createdAt: now,
    scoredTasks: scoredTasks.slice(0, 20), // top 20 for storage efficiency
    selectedTaskId,
    selectedTaskTitle,
    rationale,
    strategistBias: strategist.marketBias,
    learningSignalsSummary: summarizeLearning(learning),
  };

  await writeEmBrief(brief);

  console.log(
    `[EM] Orchestration complete. Tasks scored: ${scoredTasks.length}. ` +
    `Selected: ${selectedTaskTitle ?? "none"}. Bias: ${strategist.marketBias}.`,
  );

  return { brief, scoredTasks, selectedTaskId, selectedTaskTitle, strategist, learning };
}
