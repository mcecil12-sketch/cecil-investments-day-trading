/**
 * R-Impact Optimization Model — Agent Workflow v2
 *
 * Provides R-impact-driven task selection when the funnel is healthy.
 * Each task receives a score reflecting its expected R improvement so that
 * the execute route prioritizes changes with measurable trading impact.
 *
 * Task selection priority (when funnel is healthy):
 *   1. Critical safety / trade integrity   (impact ≥ 0.8)
 *   2. Execution blockers                  (impact ≥ 0.6)
 *   3. Highest expected R improvement      (ranked by expectedRImpact)
 *   4. Funnel conversion improvements      (impact ≥ 0.3)
 *   5. Diagnostics / informational         (impact > 0)
 *
 * Tasks are SKIPPED when:
 *   - expectedRImpact <= 0
 *   - confidence < threshold
 *   - evidenceFreshness = "stale" with no new data
 *   - duplicate executionLock holds (24h window)
 */

import type { ManualActionTask } from "@/lib/agents/manual-action-queue";
import type { EngineeringTask } from "@/lib/agents/types";

// ─── Types ────────────────────────────────────────────────────────────────

export type RImpactAffectedMetric =
  | "winRate"
  | "avgR"
  | "conversion"
  | "drawdown"
  | "unknown";

export type RImpactEvidenceFreshness = "fresh" | "stale" | "unknown";

export interface RImpactScore {
  taskId: string;
  title: string;
  source: "manual-action-queue" | "engineering-backlog";
  /** Estimated R improvement in R-multiples (0..1 scale, higher = more impact) */
  expectedRImpact: number;
  /** Confidence in the estimate, 0..1 */
  confidence: number;
  /** Whether the evidence driving this task is current */
  evidenceFreshness: RImpactEvidenceFreshness;
  /** Primary trading metric this change affects */
  affectedMetric: RImpactAffectedMetric;
  /** Human-readable hypothesis for why this improves R */
  hypothesis: string;
  /** Rollback strategy if the change degrades performance */
  rollbackPlan: string;
  /** Rank in the queue (1 = highest priority) */
  rank: number;
  /** If set, this task should be skipped */
  skipReason: string | null;
}

// ─── R-impact heuristic mappings ─────────────────────────────────────────

interface RImpactPattern {
  pattern: RegExp;
  impact: number;
  metric: RImpactAffectedMetric;
  hypothesis: string;
}

const RIMPACT_PATTERNS: RImpactPattern[] = [
  // Highest impact: protection / stop loss
  {
    pattern: /fix.*stop|stop.*protection|missing.*stop|repair.*stop|protection.*audit/i,
    impact: 0.7,
    metric: "drawdown",
    hypothesis: "Preventing unprotected losses reduces drawdown directly",
  },
  // Broker sync / position mismatch
  {
    pattern: /broker.*sync|broker.*mismatch|position.*mismatch|broker.*reconcil/i,
    impact: 0.65,
    metric: "drawdown",
    hypothesis: "Broker sync fixes prevent unexpected losses from position discrepancies",
  },
  // Funnel restoration (highest conversion impact)
  {
    pattern: /funnel.*block|fix.*funnel|restore.*funnel|fix.*scan.*signal|scan.*signal.*fail/i,
    impact: 0.55,
    metric: "conversion",
    hypothesis: "Restoring funnel flow directly recovers lost trade opportunities",
  },
  // Scanner fixes
  {
    pattern: /\bscanner\b.*(?:stale|fix|diagnos)|diagnose.*scanner|fix.*scan/i,
    impact: 0.5,
    metric: "conversion",
    hypothesis: "More candidates scanned improves signal throughput and conversion",
  },
  // Scoring pipeline fixes
  {
    pattern: /fix.*scor|scor.*pipeline|ai.*score.*drain|drain.*backlog|scoring.*backlog/i,
    impact: 0.45,
    metric: "conversion",
    hypothesis: "Scoring improvements increase qualified signal throughput",
  },
  // Signal flow fixes
  {
    pattern: /fix.*signal|signal.*flow|signal.*not.*posting|post.*signal/i,
    impact: 0.45,
    metric: "conversion",
    hypothesis: "Fixing signal flow restores the scan → qualify pipeline",
  },
  // Auto-entry / seeding fixes
  {
    pattern: /seed.*signal|signal.*seed|auto.?entry.*fix|fix.*seed/i,
    impact: 0.4,
    metric: "conversion",
    hypothesis: "Fixing seeding converts more qualified signals into executed trades",
  },
  // Win rate improvements
  {
    pattern: /win.?rate|tier.?c.*loss|high.*loss.*rate|loss.*clustering|qualification.*rate/i,
    impact: 0.3,
    metric: "winRate",
    hypothesis: "Qualification improvement expected to raise win rate",
  },
  // Avg R improvements
  {
    pattern: /avg.?r\b|avgR|negative.*r\b|r.?improvement|improve.*r\b/i,
    impact: 0.25,
    metric: "avgR",
    hypothesis: "R-value improvement expected from tighter exit/entry criteria",
  },
  // Auth / infrastructure
  {
    pattern: /auth.*token|validate.*auth|redis.*connect|infra.*fix/i,
    impact: 0.4,
    metric: "conversion",
    hypothesis: "Fixing auth/infra unblocks the entire pipeline",
  },
];

function detectRImpact(title: string, summary: string): {
  impact: number;
  metric: RImpactAffectedMetric;
  hypothesis: string;
} {
  const text = `${title} ${summary}`;
  for (const entry of RIMPACT_PATTERNS) {
    if (entry.pattern.test(text)) {
      return { impact: entry.impact, metric: entry.metric, hypothesis: entry.hypothesis };
    }
  }
  // Default: small positive impact to allow diagnostic / general tasks through
  return {
    impact: 0.1,
    metric: "unknown",
    hypothesis: "General improvement task with uncertain R impact",
  };
}

function assessEvidenceFreshness(createdAt: string): RImpactEvidenceFreshness {
  if (!createdAt) return "unknown";
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return "unknown";
  const ageH = (Date.now() - t) / (60 * 60 * 1000);
  // Within 24h: fresh (within one trading day's evidence window)
  return ageH < 24 ? "fresh" : "stale";
}

function priorityConfidence(priority: string): number {
  switch (priority.toUpperCase()) {
    case "CRITICAL": return 0.95;
    case "HIGH":     return 0.80;
    case "MEDIUM":   return 0.60;
    default:         return 0.40;
  }
}

function priorityImpactBoost(priority: string): number {
  switch (priority.toUpperCase()) {
    case "CRITICAL": return 0.20;
    case "HIGH":     return 0.10;
    default:         return 0;
  }
}

// ─── Scoring functions ──────────────────────────────────────────────────

/** Score a ManualActionTask for R-impact. */
export function scoreManualTask(task: ManualActionTask): RImpactScore {
  const { impact, metric, hypothesis } = detectRImpact(
    task.title,
    task.description ?? "",
  );

  const boost = priorityImpactBoost(task.priority);
  const expectedRImpact = Math.min(1.0, impact + boost);
  const freshness = assessEvidenceFreshness(task.createdAt);
  const confidence = priorityConfidence(task.priority);

  const rollbackPlan = task.fileHints?.length
    ? `Revert changes to: ${task.fileHints.slice(0, 2).join(", ")}`
    : "Redeploy previous commit to roll back";

  return {
    taskId: task.id,
    title: task.title,
    source: "manual-action-queue",
    expectedRImpact,
    confidence,
    evidenceFreshness: freshness,
    affectedMetric: metric,
    hypothesis,
    rollbackPlan,
    rank: 0,
    skipReason: null,
  };
}

/** Score an EngineeringTask for R-impact. */
export function scoreEngineeringTask(task: EngineeringTask): RImpactScore {
  const { impact, metric, hypothesis } = detectRImpact(
    task.title,
    task.summary ?? "",
  );

  const incidentBoost = task.incidentId ? 0.20 : 0;
  const expectedRImpact = Math.min(1.0, impact + incidentBoost);
  const freshness = assessEvidenceFreshness(task.createdAt);
  const confidence = task.incidentId ? 0.90 : 0.65;

  const rollbackPlan = task.commitPlan
    ? `Revert commit: "${task.commitPlan.commitMessage}"`
    : "Revert via redeploy of previous commit";

  return {
    taskId: task.id,
    title: task.title,
    source: "engineering-backlog",
    expectedRImpact,
    confidence,
    evidenceFreshness: freshness,
    affectedMetric: metric,
    hypothesis,
    rollbackPlan,
    rank: 0,
    skipReason: null,
  };
}

// ─── Queue builder ──────────────────────────────────────────────────────

export interface RImpactQueueOptions {
  /** Maximum tasks to include in the output queue */
  maxResults?: number;
  /** Minimum confidence to include a task */
  minConfidence?: number;
  /** Skip stale-evidence tasks when true */
  skipStale?: boolean;
}

export type RImpactSuppressionReason =
  | "CANCELED_DUPLICATE"
  | "BLOCKED_INSUFFICIENT_NEW_DATA"
  | "terminal_failed_unrecoverable";

export interface RImpactSuppressedTask {
  taskId: string;
  title: string;
  source: "manual-action-queue" | "engineering-backlog";
  reason: RImpactSuppressionReason;
  evidenceFreshness: RImpactEvidenceFreshness;
  newClosedTradesSinceLastFix: number;
}

export interface RImpactQueueWithSuppression {
  queue: RImpactScore[];
  suppressed: RImpactSuppressedTask[];
}

interface QueueCandidate {
  score: RImpactScore;
  newClosedTradesSinceLastFix: number;
  sourceStatus: string;
  rawTitle: string;
}

function normalizedTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/\[.*?\]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isAdaptiveOrProfitTask(title: string): boolean {
  return /^\[(adaptive|profitengine)\]/i.test(title.trim());
}

function extractNewClosedTradesSinceLastFix(task: EngineeringTask): number {
  const snap = task.linkedTelemetrySnapshot;
  if (!snap || typeof snap !== "object") return 0;
  const value = (snap as Record<string, unknown>).newClosedTradesSinceLastFix;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecoverableFailedManualTask(task: ManualActionTask): boolean {
  const error = String(task.latestExecutionResult?.error ?? "").toLowerCase();
  return /recoverable|timeout|rate[_ -]?limit|transient|temporary|retry/i.test(error);
}

/**
 * Build an R-impact ranked task queue + suppression diagnostics.
 */
export function buildRImpactQueueWithSuppression(
  manualTasks: ManualActionTask[],
  engineeringTasks: EngineeringTask[],
  opts?: RImpactQueueOptions,
): RImpactQueueWithSuppression {
  const max = opts?.maxResults ?? 10;
  const minConf = opts?.minConfidence ?? 0.0;
  const skipStale = opts?.skipStale ?? false;

  const suppressed: RImpactSuppressedTask[] = [];

  const manualCandidates: QueueCandidate[] = manualTasks
    .filter((t) => {
      if (t.status === "OPEN" || t.status === "SELECTED") return true;
      if (t.status === "FAILED") {
        if (isRecoverableFailedManualTask(t)) return true;
        suppressed.push({
          taskId: t.id,
          title: t.title,
          source: "manual-action-queue",
          reason: "terminal_failed_unrecoverable",
          evidenceFreshness: assessEvidenceFreshness(t.createdAt),
          newClosedTradesSinceLastFix: 0,
        });
      }
      return false;
    })
    .map((t) => ({
      score: scoreManualTask(t),
      newClosedTradesSinceLastFix: 0,
      sourceStatus: t.status,
      rawTitle: t.title,
    }));

  const engineeringCandidates: QueueCandidate[] = engineeringTasks
    .filter((t) => t.status === "OPEN" || t.status === "READY_FOR_EXECUTION")
    .map((t) => ({
      score: scoreEngineeringTask(t),
      newClosedTradesSinceLastFix: extractNewClosedTradesSinceLastFix(t),
      sourceStatus: t.status,
      rawTitle: t.title,
    }));

  const staleFiltered: QueueCandidate[] = [...manualCandidates, ...engineeringCandidates].filter((candidate) => {
    const isOptimizationClass =
      candidate.score.source === "engineering-backlog" && isAdaptiveOrProfitTask(candidate.rawTitle);
    if (
      isOptimizationClass &&
      candidate.score.evidenceFreshness === "stale" &&
      candidate.newClosedTradesSinceLastFix < 3
    ) {
      suppressed.push({
        taskId: candidate.score.taskId,
        title: candidate.score.title,
        source: candidate.score.source,
        reason: "BLOCKED_INSUFFICIENT_NEW_DATA",
        evidenceFreshness: candidate.score.evidenceFreshness,
        newClosedTradesSinceLastFix: candidate.newClosedTradesSinceLastFix,
      });
      return false;
    }
    return true;
  });

  // Duplicate suppression before ranking: keep the best candidate per title key.
  const byKey = new Map<string, QueueCandidate>();
  for (const candidate of staleFiltered) {
    const key = normalizedTitleKey(candidate.rawTitle);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, candidate);
      continue;
    }

    const existingScore = existing.score.expectedRImpact + existing.score.confidence;
    const currentScore = candidate.score.expectedRImpact + candidate.score.confidence;
    const keepCurrent = currentScore > existingScore;
    const dropped = keepCurrent ? existing : candidate;
    const kept = keepCurrent ? candidate : existing;

    byKey.set(key, kept);
    suppressed.push({
      taskId: dropped.score.taskId,
      title: dropped.score.title,
      source: dropped.score.source,
      reason: "CANCELED_DUPLICATE",
      evidenceFreshness: dropped.score.evidenceFreshness,
      newClosedTradesSinceLastFix: dropped.newClosedTradesSinceLastFix,
    });
  }

  const eligible = [...byKey.values()]
    .map((c) => c.score)
    .filter((t) => {
      if (t.expectedRImpact <= 0) return false;
      if (t.confidence < minConf) return false;
      if (skipStale && t.evidenceFreshness === "stale") return false;
      return true;
    });

  eligible.sort((a, b) => {
    const impactDiff = b.expectedRImpact - a.expectedRImpact;
    if (Math.abs(impactDiff) > 0.001) return impactDiff;
    return b.confidence - a.confidence;
  });

  eligible.forEach((t, i) => {
    t.rank = i + 1;
  });

  return {
    queue: eligible.slice(0, max),
    suppressed,
  };
}

/**
 * Build an R-impact ranked task queue combining manual and engineering tasks.
 */
export function buildRImpactQueue(
  manualTasks: ManualActionTask[],
  engineeringTasks: EngineeringTask[],
  opts?: RImpactQueueOptions,
): RImpactScore[] {
  return buildRImpactQueueWithSuppression(manualTasks, engineeringTasks, opts).queue;
}

/**
 * Get the top expected R-impact task IDs for logging/response.
 */
export function getTopRImpactTaskIds(
  queue: RImpactScore[],
  top = 3,
): Array<{ taskId: string; title: string; expectedRImpact: number; affectedMetric: RImpactAffectedMetric }> {
  return queue.slice(0, top).map((t) => ({
    taskId: t.taskId,
    title: t.title,
    expectedRImpact: t.expectedRImpact,
    affectedMetric: t.affectedMetric,
  }));
}
