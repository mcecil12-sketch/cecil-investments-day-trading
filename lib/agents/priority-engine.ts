/**
 * Priority Engine v2 — Trading Impact Ranking
 *
 * The Engineering Manager uses this to rank all tasks by trading impact.
 * Heavily biases CRITICAL issues (execution, latency, stale signals) over low-value work.
 *
 * Ranking formula:
 *   priorityScore = tradingImpactWeight * severity * urgency * confidence
 *
 * Task freezing:
 *   if seededToExecutedPct < 40% OR freshSignalPct < 50% OR latencySec > 300
 *   then freezeNonCriticalWork = true
 *
 * Only allowed during freeze:
 *   - EXECUTION fixes
 *   - RISK/PROTECTION tasks
 *   - CRITICAL_ENGINEERING
 *   - PERFORMANCE
 */

import type { EngineeringTask, BacklogItem } from "@/lib/agents/types";
import { calculateFreezeConditions } from "@/lib/agents/trading-kpis";
import type { SharedTradingKpis } from "@/lib/agents/trading-kpis";

// ─── Priority Weights ─────────────────────────────────────────────────────────

export type PriorityCategory =
  | "EXECUTION"
  | "RISK"
  | "PERFORMANCE"
  | "CRITICAL_ENGINEERING"
  | "FEATURE"
  | "OPTIMIZATION"
  | "COSMETIC"
  | "UNKNOWN";

export interface PriorityScore {
  taskId: string;
  title: string;
  category: PriorityCategory;
  score: number; // 0–100
  severity: number; // 0–10
  urgency: number; // 0–10
  tradingImpact: number; // 0–10
  confidence: number; // 0–1
  frozen: boolean;
  freezeReason?: string;
  rationale: string[];
}

// ─── Keyword patterns for categorization ────────────────────────────────────────

const EXECUTION_PATTERNS = [
  /execution|seed|qualified|drain|backlog|qualified.*execute|execute.*fail|broker.*order/i,
];

const RISK_PATTERNS = [
  /risk|stop|protection|deep.loss|drawdown|guard|safeguard|position.mismatch|broker.sync|broker.reconcil/i,
];

const PERFORMANCE_PATTERNS = [
  /latency|throughput|speed|optimize|bottleneck|slow|lag/i,
];

const CRITICAL_ENGINEERING_PATTERNS = [
  /critical|crash|error|stale|stuck|loop|timeout|retry|queue|sync|mismatch|orphan|deadlock|race/i,
];

const FEATURE_PATTERNS = [
  /feature|new|add|implement|enhance|capability|support/i,
];

const OPTIMIZATION_PATTERNS = [
  /optim|refactor|clean|improve|simplif|technicaldebt|debt/i,
];

const COSMETIC_PATTERNS = [
  /style|color|font|icon|layout|margin|padding|css|ui|ux|label|rename|typo|comment|doc/i,
];

// ─── Heat maps for task-keyword scoring ────────────────────────────────────────

const SEVERITY_KEYWORDS: Record<string, number> = {
  "execution failure": 10,
  "latency > 300s": 9,
  "stale signals > 50%": 9,
  "seeded < 40%": 8,
  "position mismatch": 8,
  "broker error": 8,
  "stop protection": 9,
  "deep loss": 10,
  "drawdown": 8,
  crash: 10,
  error: 8,
  stuck: 7,
  "pnl integrity": 9,
  "scoring failure": 7,
};

// ─── Categorization Helper ────────────────────────────────────────────────────

function categorizeTask(title: string, summary = ""): PriorityCategory {
  const text = `${title} ${summary}`.toLowerCase();

  if (EXECUTION_PATTERNS.some((p) => p.test(text))) return "EXECUTION";
  if (RISK_PATTERNS.some((p) => p.test(text))) return "RISK";
  if (PERFORMANCE_PATTERNS.some((p) => p.test(text))) return "PERFORMANCE";
  if (CRITICAL_ENGINEERING_PATTERNS.some((p) => p.test(text)))
    return "CRITICAL_ENGINEERING";
  if (FEATURE_PATTERNS.some((p) => p.test(text))) return "FEATURE";
  if (OPTIMIZATION_PATTERNS.some((p) => p.test(text))) return "OPTIMIZATION";
  if (COSMETIC_PATTERNS.some((p) => p.test(text))) return "COSMETIC";

  return "UNKNOWN";
}

// ─── Inference Helpers ────────────────────────────────────────────────────────

function inferSeverity(
  title: string,
  category: PriorityCategory,
): number {
  const text = title.toLowerCase();

  // Base severity by category
  let severity = 3; // default
  switch (category) {
    case "EXECUTION":
      severity = 8;
      break;
    case "RISK":
      severity = 9;
      break;
    case "PERFORMANCE":
      severity = 7;
      break;
    case "CRITICAL_ENGINEERING":
      severity = 7;
      break;
    case "FEATURE":
      severity = 4;
      break;
    case "OPTIMIZATION":
      severity = 3;
      break;
    case "COSMETIC":
      severity = 1;
      break;
  }

  // Boost for specific keywords
  for (const [keyword, boost] of Object.entries(SEVERITY_KEYWORDS)) {
    if (text.includes(keyword.toLowerCase())) {
      severity = Math.max(severity, boost);
    }
  }

  return Math.max(1, Math.min(10, severity));
}

function inferUrgency(
  title: string,
  createdAt?: string,
): number {
  const text = title.toLowerCase();

  let urgency = 5; // default

  // Age-based urgency
  if (createdAt) {
    const ageHours = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60);
    if (ageHours > 24) urgency += 2;
    if (ageHours > 72) urgency += 1;
  }

  // Keyword-based urgency
  if (/critical|urgent|blocker|broken|fail/i.test(text)) {
    urgency = Math.max(urgency, 9);
  } else if (/high|important/i.test(text)) {
    urgency = Math.max(urgency, 7);
  }

  return Math.max(1, Math.min(10, urgency));
}

function inferTradingImpact(
  title: string,
  category: PriorityCategory,
): number {
  const text = title.toLowerCase();

  // Base impact by category (higher = more trading-relevant)
  let impact = 2; // default
  switch (category) {
    case "EXECUTION":
      impact = 10; // execution directly drives R
      break;
    case "RISK":
      impact = 9; // risk directly impacts drawdown
      break;
    case "PERFORMANCE":
      impact = 7; // latency affects execution
      break;
    case "CRITICAL_ENGINEERING":
      impact = 5; // system health impacts trading
      break;
    case "FEATURE":
      impact = 3;
      break;
    case "OPTIMIZATION":
      impact = 2;
      break;
    case "COSMETIC":
      impact = 0;
      break;
  }

  // Boost for specific trading-relevant keywords
  if (/qual.*execute|execution rate|latency|stale.*signal|stop|protection/i.test(text)) {
    impact = Math.max(impact, 8);
  }

  return Math.max(0, Math.min(10, impact));
}

function inferConfidence(
  title: string,
  hasSummary: boolean,
): number {
  let confidence = 0.5; // default

  if (hasSummary) confidence += 0.2;

  if (/fix|repair|resolve/i.test(title)) {
    confidence += 0.2;
  } else if (/investigate|explore|analyze/i.test(title)) {
    confidence -= 0.1;
  }

  return Math.max(0, Math.min(1, confidence));
}

// ─── Main Scoring Function ────────────────────────────────────────────────────

/**
 * Calculate priority score for a single task.
 *
 * Returns 0–100 score with category classification.
 * Takes into account trading impact, funnel health, and work freeze conditions.
 */
export function scoreTask(
  task: Partial<EngineeringTask> | Partial<BacklogItem>,
  tradingKpis: SharedTradingKpis,
): PriorityScore {
  const title = (task as EngineeringTask).title || (task as BacklogItem).title || "Unknown";
  const summary = (task as EngineeringTask).summary || (task as BacklogItem).summary || "";
  const createdAt = (task as EngineeringTask).createdAt || (task as BacklogItem).createdAt;

  const category = categorizeTask(title, summary);
  const severity = inferSeverity(title, category);
  const urgency = inferUrgency(title, createdAt);
  const tradingImpact = inferTradingImpact(title, category);
  const confidence = inferConfidence(title, !!summary);

  // Base score formula: severity × urgency × trading impact × confidence
  let rawScore = (severity * urgency * tradingImpact * confidence) / 10;
  rawScore = Math.max(0, Math.min(100, rawScore));

  // Check freeze conditions
  const { shouldFreeze, allowedWorkTypes } = calculateFreezeConditions(tradingKpis);

  let frozen = false;
  let freezeReason: string | undefined;

  if (shouldFreeze && !allowedWorkTypes.includes(category)) {
    frozen = true;
    freezeReason = `Work frozen during funnel degradation. Only ${allowedWorkTypes.join(", ")} allowed.`;
    // Deprioritize frozen tasks
    rawScore *= 0.1;
  }

  const rationale: string[] = [];
  rationale.push(`Category: ${category} | Severity: ${severity}/10 | Urgency: ${urgency}/10`);
  rationale.push(`Trading impact: ${tradingImpact}/10 | Confidence: ${(confidence * 100).toFixed(0)}%`);

  if (tradingKpis.isCritical) {
    rationale.push(`App in CRITICAL state: ${tradingKpis.freezeReasons.join("; ")}`);
  }

  if (frozen) {
    rationale.push(`FROZEN: ${freezeReason}`);
  }

  return {
    taskId: (task as EngineeringTask).id || (task as BacklogItem).id || "unknown",
    title,
    category,
    score: rawScore,
    severity,
    urgency,
    tradingImpact,
    confidence,
    frozen,
    freezeReason,
    rationale,
  };
}

/**
 * Score and rank multiple tasks by priority.
 * Returns sorted by score (highest first).
 */
export function rankTasks(
  tasks: Array<Partial<EngineeringTask> | Partial<BacklogItem>>,
  tradingKpis: SharedTradingKpis,
): PriorityScore[] {
  const scored = tasks.map((t) => scoreTask(t, tradingKpis));

  // Sort: non-frozen descending by score, then frozen tasks
  return scored.sort((a, b) => {
    if (a.frozen !== b.frozen) {
      return a.frozen ? 1 : -1;
    }
    return b.score - a.score;
  });
}

/**
 * Select the highest-priority task that is not frozen.
 */
export function selectNextTask(
  tasks: Array<Partial<EngineeringTask> | Partial<BacklogItem>>,
  tradingKpis: SharedTradingKpis,
): PriorityScore | null {
  const ranked = rankTasks(tasks, tradingKpis);
  return ranked.find((t) => !t.frozen) || null;
}

/**
 * Filter tasks by allowed work types during freeze.
 */
export function filterByWorkType(
  tasks: PriorityScore[],
  allowedTypes: PriorityCategory[],
): PriorityScore[] {
  return tasks.filter((t) => allowedTypes.includes(t.category));
}

/**
 * Build a summary of task distribution by priority band.
 */
export function summarizeTaskDistribution(
  scored: PriorityScore[],
): {
  critical: number;
  high: number;
  medium: number;
  low: number;
  frozen: number;
} {
  return {
    critical: scored.filter((t) => t.score >= 80 && !t.frozen).length,
    high: scored.filter((t) => t.score >= 60 && t.score < 80 && !t.frozen).length,
    medium: scored.filter((t) => t.score >= 40 && t.score < 60 && !t.frozen).length,
    low: scored.filter((t) => t.score < 40 && !t.frozen).length,
    frozen: scored.filter((t) => t.frozen).length,
  };
}
