/**
 * Execution Agent Manager v2 — Funnel Optimization
 *
 * Autonomous agent focused on optimizing the qualified → seeded → executed funnel.
 *
 * Responsibilities:
 *  1. Optimize execution latency (target: < 60 sec)
 *  2. Maximize fresh signal % (target: > 80%)
 *  3. Maximize seeded → executed conversion (target: > 60%)
 *  4. Eliminate duplicate seeds (target: 0%)
 *  5. Minimize stale signals (target: < 10%)
 *  6. Monitor broker rejects and price drift
 *
 * Auto-opens issues when critical thresholds are breached.
 *
 * KPIs (all agents include these):
 *  - functional: latency < 60s, duplicates = 0, conversion > 60%
 *  - trading: execution rate impact on avg R
 *  - penalty: breaches of critical thresholds
 */

import { redis } from "@/lib/redis";
import { nowIso } from "@/lib/agents/time";
import { createManualActionTask } from "@/lib/agents/manual-action-queue";
import type { AgentKpiSummary } from "@/lib/agents/kpis";
import { computeAgentKpiSummary, calculateAgentScore, classifyAgentPerformance } from "@/lib/agents/kpis";
import type { SharedTradingKpis } from "@/lib/agents/trading-kpis";
import { detectKpiViolations } from "@/lib/agents/trading-kpis";

// ─── Execution Agent State ────────────────────────────────────────────────────

export interface ExecutionAgentBrief {
  asOf: string;

  // KPIs
  kpis: AgentKpiSummary;

  // Current funnel metrics
  executionLatencySec: number;
  freshSignalPct: number;
  seededToExecutedPct: number;
  staleSignalPct: number;
  duplicateSeedRate: number;

  // Incident detection
  openIncidents: ExecutionIncident[];
  closedIncidentsToday: number;

  // Next action
  nextAction: string;
  actionConfidence: number;
}

export interface ExecutionIncident {
  id: string;
  title: string;
  category: ExecutionIncidentCategory;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  metric: string; // latency, freshness, conversion, duplicates
  threshold: number;
  currentValue: number;
  detectedAt: string;
  createdTask?: string;
}

export type ExecutionIncidentCategory =
  | "LATENCY"
  | "STALE_SIGNALS"
  | "EXECUTION_CONVERSION"
  | "DUPLICATE_SEEDS"
  | "BROKER_REJECT"
  | "PRICE_DRIFT";

// ─── Critical Thresholds ──────────────────────────────────────────────────────

const EXECUTION_THRESHOLDS = {
  // Latency: warning → critical
  latencyWarningThreshold: 120, // 2 minutes
  latencyCriticalThreshold: 300, // 5 minutes

  // Freshness: warning → critical
  freshnessCriticalThreshold: 50, // < 50% is critical
  freshnessWarningThreshold: 70, // < 70% is warning

  // Execution conversion: warning → critical
  executionCriticalThreshold: 40, // < 40% is critical
  executionWarningThreshold: 55, // < 55% is warning

  // Stale signals: warning → critical
  staleCriticalThreshold: 50, // > 50% is critical
  staleWarningThreshold: 30, // > 30% is warning

  // Duplicate seeds
  duplicateCriticalThreshold: 0.05, // > 5% is critical
  duplicateWarningThreshold: 0.02, // > 2% is warning
};

// ─── Storage Keys ──────────────────────────────────────────────────────────────

const EXECUTION_AGENT_BRIEF_KEY = "agents:execution:brief";
const EXECUTION_INCIDENTS_KEY = "agents:execution:incidents";
const EXECUTION_HISTORY_KEY = "agents:execution:history";

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute current execution agent KPIs.
 *
 * Takes trading KPIs and derives execution-specific scores.
 */
export function computeExecutionKpis(
  tradingKpis: SharedTradingKpis,
): AgentKpiSummary {
  // Functional: latency < 60s, duplicates = 0, conversion > 60%
  let functionalScore = 5;

  if (tradingKpis.executionLatencySec < 60) {
    functionalScore += 2; // bonus for sub-60s
  } else if (tradingKpis.executionLatencySec > 300) {
    functionalScore -= 3; // penalty for critical
  }

  if (tradingKpis.duplicateSeedRate === 0) {
    functionalScore += 1.5; // bonus for zero duplicates
  } else if (tradingKpis.duplicateSeedRate > 0.05) {
    functionalScore -= 2;
  }

  if (tradingKpis.seededToExecutedPct > 60) {
    functionalScore += 2;
  } else if (tradingKpis.seededToExecutedPct < 40) {
    functionalScore -= 3;
  }

  // Trading: execution rate directly impacts R
  const tradingScore = (tradingKpis.executionRate * 100) / 12.5; // scale to 0–10

  // Penalty: stale signals, latency, misses
  let penaltyScore = 0;
  if (tradingKpis.staleSignalPct > EXECUTION_THRESHOLDS.staleCriticalThreshold) {
    penaltyScore += 3;
  }
  if (tradingKpis.executionLatencySec > EXECUTION_THRESHOLDS.latencyCriticalThreshold) {
    penaltyScore += 3;
  }
  if (tradingKpis.duplicateSeedRate > EXECUTION_THRESHOLDS.duplicateCriticalThreshold) {
    penaltyScore += 2;
  }

  return computeAgentKpiSummary("execution", tradingKpis, {
    taskCompletionRate: Math.min(1, tradingKpis.executionRate / 100),
  });
}

/**
 * Detect execution incidents from trading KPIs.
 */
export function detectExecutionIncidents(
  tradingKpis: SharedTradingKpis,
): ExecutionIncident[] {
  const incidents: ExecutionIncident[] = [];

  // LATENCY
  if (tradingKpis.executionLatencySec > EXECUTION_THRESHOLDS.latencyCriticalThreshold) {
    incidents.push({
      id: `exec-latency-${Date.now()}`,
      title: `CRITICAL: Execution latency ${tradingKpis.executionLatencySec.toFixed(0)}s (> 300s)`,
      category: "LATENCY",
      severity: "CRITICAL",
      metric: "executionLatencySec",
      threshold: EXECUTION_THRESHOLDS.latencyCriticalThreshold,
      currentValue: tradingKpis.executionLatencySec,
      detectedAt: nowIso(),
    });
  } else if (tradingKpis.executionLatencySec > EXECUTION_THRESHOLDS.latencyWarningThreshold) {
    incidents.push({
      id: `exec-latency-warn-${Date.now()}`,
      title: `WARNING: Execution latency ${tradingKpis.executionLatencySec.toFixed(0)}s (> 120s)`,
      category: "LATENCY",
      severity: "HIGH",
      metric: "executionLatencySec",
      threshold: EXECUTION_THRESHOLDS.latencyWarningThreshold,
      currentValue: tradingKpis.executionLatencySec,
      detectedAt: nowIso(),
    });
  }

  // STALE SIGNALS
  if (tradingKpis.staleSignalPct > EXECUTION_THRESHOLDS.staleCriticalThreshold) {
    incidents.push({
      id: `exec-stale-${Date.now()}`,
      title: `CRITICAL: Stale signals ${tradingKpis.staleSignalPct.toFixed(0)}% (> 50%)`,
      category: "STALE_SIGNALS",
      severity: "CRITICAL",
      metric: "staleSignalPct",
      threshold: EXECUTION_THRESHOLDS.staleCriticalThreshold,
      currentValue: tradingKpis.staleSignalPct,
      detectedAt: nowIso(),
    });
  }

  // EXECUTION CONVERSION
  if (tradingKpis.seededToExecutedPct < EXECUTION_THRESHOLDS.executionCriticalThreshold) {
    incidents.push({
      id: `exec-conversion-${Date.now()}`,
      title: `CRITICAL: Execution conversion ${tradingKpis.seededToExecutedPct.toFixed(0)}% (< 40%)`,
      category: "EXECUTION_CONVERSION",
      severity: "CRITICAL",
      metric: "seededToExecutedPct",
      threshold: EXECUTION_THRESHOLDS.executionCriticalThreshold,
      currentValue: tradingKpis.seededToExecutedPct,
      detectedAt: nowIso(),
    });
  } else if (tradingKpis.seededToExecutedPct < EXECUTION_THRESHOLDS.executionWarningThreshold) {
    incidents.push({
      id: `exec-conversion-warn-${Date.now()}`,
      title: `WARNING: Execution conversion ${tradingKpis.seededToExecutedPct.toFixed(0)}% (< 55%)`,
      category: "EXECUTION_CONVERSION",
      severity: "HIGH",
      metric: "seededToExecutedPct",
      threshold: EXECUTION_THRESHOLDS.executionWarningThreshold,
      currentValue: tradingKpis.seededToExecutedPct,
      detectedAt: nowIso(),
    });
  }

  // DUPLICATE SEEDS
  if (tradingKpis.duplicateSeedRate > EXECUTION_THRESHOLDS.duplicateCriticalThreshold) {
    incidents.push({
      id: `exec-dupes-${Date.now()}`,
      title: `High duplicate seed rate ${(tradingKpis.duplicateSeedRate * 100).toFixed(1)}% (> 5%)`,
      category: "DUPLICATE_SEEDS",
      severity: "HIGH",
      metric: "duplicateSeedRate",
      threshold: EXECUTION_THRESHOLDS.duplicateCriticalThreshold,
      currentValue: tradingKpis.duplicateSeedRate,
      detectedAt: nowIso(),
    });
  }

  return incidents;
}

/**
 * Auto-create engineering tasks for critical execution incidents.
 */
export async function createIncidentTasks(
  incidents: ExecutionIncident[],
): Promise<string[]> {
  const taskIds: string[] = [];

  for (const incident of incidents.filter((i) => i.severity === "CRITICAL")) {
    try {
      const task = await createManualActionTask({
        taskType: "AUTO_ENTRY",
        priority: incident.severity === "CRITICAL" ? "CRITICAL" : "HIGH",
        title: incident.title,
        description: `Execution agent detected ${incident.category} incident. Current: ${incident.currentValue.toFixed(2)}, Threshold: ${incident.threshold.toFixed(2)}`,
        fileHints: [
          "lib/autoEntry/guardrails.ts",
          "lib/agents/execution/engine.ts",
          "app/api/seeds/route.ts",
        ],
        routeHints: ["/api/funnel-stats", "/api/funnel-health", "/api/execution/metrics"],
        createdBy: "execution_agent",
        source: "execution_agent",
        objective: "Investigate and remediate execution funnel degradation",
        executionReady: true,
        // ─── Performance ownership ────────────────────────────────────
        ownedMetric: incident.metric,
        beforeValue: null,
        currentValue: incident.currentValue,
        targetValue: incident.threshold,
        performanceDelta: null,
        nextAction: `Review ${incident.category} in funnel-health and seed-from-signals logs. Fix root cause and verify ${incident.metric} improves toward ${incident.threshold}.`,
      });

      if (task?.id) {
        taskIds.push(task.id);
        incident.createdTask = task.id;
      }
    } catch {
      // non-fatal
    }
  }

  return taskIds;
}

/**
 * Compute execution agent brief.
 */
export async function computeExecutionBrief(
  tradingKpis: SharedTradingKpis,
): Promise<ExecutionAgentBrief> {
  const kpis = computeExecutionKpis(tradingKpis);
  const incidents = detectExecutionIncidents(tradingKpis);

  // Auto-create tasks for critical incidents
  const createdTaskIds = await createIncidentTasks(incidents);

  // Determine next action
  let nextAction = "Monitor execution health";
  let actionConfidence = 0.5;

  if (incidents.some((i) => i.severity === "CRITICAL" && i.category === "LATENCY")) {
    nextAction = "URGENT: Investigate execution latency blockers";
    actionConfidence = 0.9;
  } else if (incidents.some((i) => i.severity === "CRITICAL" && i.category === "EXECUTION_CONVERSION")) {
    nextAction = "URGENT: Debug seed-to-execute conversion failure";
    actionConfidence = 0.9;
  } else if (incidents.some((i) => i.severity === "CRITICAL" && i.category === "STALE_SIGNALS")) {
    nextAction = "URGENT: Fix stale signal reseeding pipeline";
    actionConfidence = 0.85;
  }

  return {
    asOf: nowIso(),
    kpis,
    executionLatencySec: tradingKpis.executionLatencySec,
    freshSignalPct: tradingKpis.freshSignalPct,
    seededToExecutedPct: tradingKpis.seededToExecutedPct,
    staleSignalPct: tradingKpis.staleSignalPct,
    duplicateSeedRate: tradingKpis.duplicateSeedRate,
    openIncidents: incidents,
    closedIncidentsToday: 0, // TODO: track historicly
    nextAction,
    actionConfidence,
  };
}

/**
 * Write execution agent brief to Redis.
 */
export async function writeExecutionBrief(
  brief: ExecutionAgentBrief,
): Promise<void> {
  if (!redis) return;

  try {
    const key = EXECUTION_AGENT_BRIEF_KEY;
    await redis.set(key, JSON.stringify(brief));
    await redis.expire(key, 3600); // 1h TTL
  } catch {
    // non-fatal
  }
}

/**
 * Read execution agent brief from Redis.
 */
export async function readExecutionBrief(): Promise<ExecutionAgentBrief | null> {
  if (!redis) return null;

  try {
    const raw = await redis.get<string>(EXECUTION_AGENT_BRIEF_KEY);
    if (!raw) return null;

    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === "object" && "kpis" in parsed) {
      return parsed as ExecutionAgentBrief;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Execution agent health summary.
 */
export function summarizeExecutionHealth(brief: ExecutionAgentBrief): string {
  const { kpis, executionLatencySec, freshSignalPct, seededToExecutedPct } = brief;
  const performance = classifyAgentPerformance(kpis.totalScore);

  const parts: string[] = [
    `Execution Agent: ${performance} (score: ${kpis.totalScore.toFixed(1)})`,
    `Latency: ${executionLatencySec.toFixed(0)}s`,
    `Fresh signals: ${freshSignalPct.toFixed(0)}%`,
    `Conversion: ${seededToExecutedPct.toFixed(0)}%`,
  ];

  if (brief.openIncidents.length > 0) {
    const criticalCount = brief.openIncidents.filter((i) => i.severity === "CRITICAL").length;
    parts.push(`🔴 ${criticalCount} CRITICAL incidents`);
  }

  return parts.join(" | ");
}
