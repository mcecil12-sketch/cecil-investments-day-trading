/**
 * Task Prioritization Engine — Phase 3
 *
 * Scores engineering tasks and backlog items across nine dimensions.
 * Hard-biased toward risk integrity, deep-loss prevention, and trading outcomes.
 * Returns a prioritized list with bucket labels and rationale.
 */

import { nowIso } from "@/lib/agents/time";
import type {
  BacklogItem,
  EngineeringTask,
  PerformanceLearningSignals,
  ScoredTask,
  StrategistBrief,
  TaskPriorityBucket,
  TaskPriorityDimensions,
} from "@/lib/agents/types";

// ─── Dimension weights ────────────────────────────────────────────────────────
// Sum must be >=1. Dimensions with larger weights dominate the score.
const WEIGHTS: Record<keyof TaskPriorityDimensions, number> = {
  tradingImpact: 2.2,
  reliabilityImpact: 1.8,
  throughputImpact: 1.4,
  riskImpact: 2.5, // highest — risk integrity is the top priority
  learningValue: 1.2,
  growthValue: 1.0,
  complexity: 0.8, // inverted: lower complexity = higher score contribution
  reversibility: 0.7,
  urgency: 1.8,
};

// Keyword patterns mapped to trading-impact domains (checked against task title + summary)
const HIGH_RISK_PATTERNS = [
  /risk|stop|protection|deep.loss|drawdown|guard|safeguard|hedge|circuit.breaker/i,
];
const HIGH_TRADING_PATTERNS = [
  /score|qualify|qual|funnel|signal|entry|auto.entry|tier|grade|ai|regime|bias/i,
];
const HIGH_RELIABILITY_PATTERNS = [
  /crash|error|stale|stuck|loop|timeout|retry|queue|broker|sync|mismatch|orphan/i,
];
const THROUGHPUT_PATTERNS = [
  /throughput|drain|pipeline|latency|scan|feed|batch|concurren/i,
];
const LEARNING_PATTERNS = [
  /learn|correct|improv|lesson|track|histor|analyt|insight|perf/i,
];
const SHORT_SIDE_PATTERNS = [
  /short|bearish|sell.side|inverse/i,
];
const COSMETIC_PATTERNS = [
  /style|color|font|icon|layout|margin|padding|css|ui|ux|label|rename|typo|comment/i,
];

function matchesAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((p) => p.test(text));
}

function clamp(value: number, min = 0, max = 10): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Infer dimension scores from a task's title/summary plus optional signals.
 */
function inferDimensions(
  title: string,
  summary: string,
  priority: "HIGH" | "MEDIUM" | "LOW",
  learning: PerformanceLearningSignals | null,
  strategist: StrategistBrief | null,
): TaskPriorityDimensions {
  const text = `${title} ${summary}`.toLowerCase();
  const isHighPriority = priority === "HIGH";
  const isMedPriority = priority === "MEDIUM";

  // Base scores derived from keyword matching
  const tradingImpact = clamp(
    (matchesAny(HIGH_TRADING_PATTERNS, text) ? 7 : 3) +
    (isHighPriority ? 2 : isMedPriority ? 1 : 0) +
    // Boost if strategist is RISK_OFF and this is a risk task
    (strategist?.marketBias === "RISK_OFF" && matchesAny(HIGH_RISK_PATTERNS, text) ? 1.5 : 0),
  );

  const reliabilityImpact = clamp(
    (matchesAny(HIGH_RELIABILITY_PATTERNS, text) ? 7 : 2) +
    (isHighPriority ? 2 : isMedPriority ? 1 : 0),
  );

  const throughputImpact = clamp(
    (matchesAny(THROUGHPUT_PATTERNS, text) ? 6 : 2) +
    (isHighPriority ? 1.5 : 0),
  );

  const riskImpact = clamp(
    (matchesAny(HIGH_RISK_PATTERNS, text) ? 8 : 1) +
    (matchesAny(SHORT_SIDE_PATTERNS, text) ? 1.5 : 0) +
    // If we have a high deep-loss rate, risk tasks are more urgent
    (learning && learning.deepLossRate > 0.15 && matchesAny(HIGH_RISK_PATTERNS, text) ? 2 : 0),
  );

  const learningValue = clamp(
    (matchesAny(LEARNING_PATTERNS, text) ? 6 : 2) +
    (isHighPriority ? 1 : 0),
  );

  const growthValue = clamp(
    (matchesAny(SHORT_SIDE_PATTERNS, text)
      ? (learning && learning.shortWinRate < 0.4 ? 7 : 4)
      : 3) +
    (isHighPriority ? 1 : 0),
  );

  // Complexity: cosmetic tasks are low complexity, infra tasks are higher
  const complexity = clamp(
    matchesAny(COSMETIC_PATTERNS, text) ? 2 : isHighPriority ? 6 : 4,
  );

  // Reversibility: config/flag changes are reversible; file rewrites are less so
  const reversibility = clamp(
    /flag|config|setting|env|toggle|feature.flag/i.test(text) ? 8 :
    /rewrite|migrate|replace|remove|delete/i.test(text) ? 3 : 6,
  );

  const urgency = clamp(
    (isHighPriority ? 8 : isMedPriority ? 5 : 2) +
    // Boost urgency for tasks addressing active learning signals
    (learning && learning.deepLossRate > 0.2 && matchesAny(HIGH_RISK_PATTERNS, text) ? 2 : 0),
  );

  return {
    tradingImpact,
    reliabilityImpact,
    throughputImpact,
    riskImpact,
    learningValue,
    growthValue,
    complexity,
    reversibility,
    urgency,
  };
}

/**
 * Compute a 0–100 weighted priority score from dimensions.
 * Complexity is inverted so that simpler tasks score higher.
 */
function computePriorityScore(dims: TaskPriorityDimensions): number {
  const weighted =
    dims.tradingImpact * WEIGHTS.tradingImpact +
    dims.reliabilityImpact * WEIGHTS.reliabilityImpact +
    dims.throughputImpact * WEIGHTS.throughputImpact +
    dims.riskImpact * WEIGHTS.riskImpact +
    dims.learningValue * WEIGHTS.learningValue +
    dims.growthValue * WEIGHTS.growthValue +
    (10 - dims.complexity) * WEIGHTS.complexity + // invert complexity
    dims.reversibility * WEIGHTS.reversibility +
    dims.urgency * WEIGHTS.urgency;

  const maxPossible =
    10 * WEIGHTS.tradingImpact +
    10 * WEIGHTS.reliabilityImpact +
    10 * WEIGHTS.throughputImpact +
    10 * WEIGHTS.riskImpact +
    10 * WEIGHTS.learningValue +
    10 * WEIGHTS.growthValue +
    10 * WEIGHTS.complexity +
    10 * WEIGHTS.reversibility +
    10 * WEIGHTS.urgency;

  return Math.round((weighted / maxPossible) * 100);
}

function scoreToBucket(score: number): TaskPriorityBucket {
  if (score >= 80) return "CRITICAL";
  if (score >= 60) return "HIGH";
  if (score >= 35) return "MEDIUM";
  return "LOW";
}

function buildRationale(dims: TaskPriorityDimensions, bucket: TaskPriorityBucket, title: string): string {
  const parts: string[] = [];
  if (dims.riskImpact >= 7) parts.push("high risk integrity value");
  if (dims.tradingImpact >= 7) parts.push("direct trading outcome impact");
  if (dims.reliabilityImpact >= 7) parts.push("addresses reliability gap");
  if (dims.urgency >= 7) parts.push("urgent");
  if (dims.learningValue >= 6) parts.push("strong learning signal");
  if (dims.growthValue >= 6) parts.push("growth opportunity");
  if ((10 - dims.complexity) >= 7) parts.push("low implementation risk");
  if (dims.throughputImpact >= 6) parts.push("throughput blocker");
  const reason = parts.length > 0 ? parts.join(", ") : "baseline score";
  return `"${title}" → ${bucket} (${reason})`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export type ScoringInput =
  | { kind: "task"; task: EngineeringTask }
  | { kind: "backlog"; item: BacklogItem };

export function scoreItem(
  input: ScoringInput,
  learning: PerformanceLearningSignals | null,
  strategist: StrategistBrief | null,
): ScoredTask {
  const now = nowIso();

  let taskId: string;
  let title: string;
  let summary: string;
  let priority: "HIGH" | "MEDIUM" | "LOW";

  if (input.kind === "task") {
    taskId = input.task.id;
    title = input.task.title;
    summary = input.task.summary;
    // Map engineering task status to priority hint
    priority = input.task.status === "READY_FOR_EXECUTION" ? "HIGH" : "MEDIUM";
  } else {
    taskId = input.item.id;
    title = input.item.title;
    summary = input.item.summary;
    priority = input.item.priority;
  }

  const dimensions = inferDimensions(title, summary, priority, learning, strategist);
  const priorityScore = computePriorityScore(dimensions);
  const priorityBucket = scoreToBucket(priorityScore);
  const rationale = buildRationale(dimensions, priorityBucket, title);

  return {
    taskId,
    title,
    dimensions,
    priorityScore,
    priorityBucket,
    rationale,
    scoredAt: now,
  };
}

export function scoreAndRank(
  inputs: ScoringInput[],
  learning: PerformanceLearningSignals | null,
  strategist: StrategistBrief | null,
): ScoredTask[] {
  return inputs
    .map((input) => scoreItem(input, learning, strategist))
    .sort((a, b) => b.priorityScore - a.priorityScore);
}
