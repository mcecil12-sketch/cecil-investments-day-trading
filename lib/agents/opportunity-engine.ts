import { listOpenIncidents } from "@/lib/agents/store";
import { listEngineeringTasks } from "@/lib/agents/store";
import { getSharedTradingKpis, type SharedTradingKpis } from "@/lib/agents/trading-kpis";
import { buildAgentOpportunityDedupeKey, normalizeAgentIssueKey } from "@/lib/agents/root-cause";
import { readRootCauseExecutionState } from "@/lib/agents/task-dedup";

export type OpportunityCategory =
  | "P0_TRADING_BLOCKERS"
  | "P1_FUNNEL_OPTIMIZATION"
  | "P2_R_OPTIMIZATION"
  | "P3_THROUGHPUT_OPTIMIZATION"
  | "P4_SYSTEM_QUALITY"
  | "P5_UI_CLEANUP";

export type OpportunityPriority = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export type ExpectedRImpact = "positive" | "neutral" | "negative" | "unknown";

export interface PerformanceOpportunity {
  id: string;
  title: string;
  description: string;
  category: OpportunityCategory;
  priority: OpportunityPriority;
  expectedRImpact: ExpectedRImpact;
  estimatedImpactText: string;
  confidence: number;
  owner: string;
  rootCauseKey: string;
  dedupeKey: string;
  taskId?: string | null;
  beforeMetrics?: Record<string, number | null>;
  completionRequirements?: string[];
  cooldownActive?: boolean;
  cooldownUntil?: string | null;
  rationale: string;
  createdAt: string;
  status: "OPEN" | "MONITORING" | "RESOLVED";
}

function buildBeforeMetrics(kpis: SharedTradingKpis | null): Record<string, number | null> {
  const src = kpis as unknown as Record<string, unknown> | null;
  const num = (key: string): number | null => {
    const n = Number(src?.[key]);
    return Number.isFinite(n) ? n : null;
  };

  return {
    qualifiedToSeedLatencyAvgMs: num("qualifiedToSeedLatencyAvgMs"),
    qualifiedToSeedLatencyMaxMs: num("qualifiedToSeedLatencyMaxMs"),
    seededToExecutedPct: num("seededToExecutedPct"),
    freshSignalPct: num("freshSignalPct"),
    staleSignalPct: num("staleSignalPct"),
    avgR: num("avgRealizedR"),
    realizedR: num("actualRImpactRecent"),
  };
}

function completionRequirementsFor(title: string): string[] {
  const t = title.toLowerCase();
  if (t.includes("latency") || t.includes("seeded to executed") || t.includes("stale signal")) {
    return [
      "latency improves",
      "freshSignalPct improves",
      "seededToExecutedPct improves",
      "no execution regression",
    ];
  }
  return ["measurable KPI improvement", "no trading-flow regression"];
}

function nowIso() {
  return new Date().toISOString();
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function defaultOpportunities(now: string): PerformanceOpportunity[] {
  return [
    {
      id: `opp-default-exec-latency-${now}`,
      title: "Reduce qualified to execute latency",
      description: "Improve handoff speed between qualification, seeding, and execution to increase fill quality.",
      category: "P1_FUNNEL_OPTIMIZATION",
      priority: "HIGH",
      expectedRImpact: "positive",
      estimatedImpactText: "+0.4R to +1.2R/day",
      confidence: 0.65,
      owner: "execution",
      rootCauseKey: normalizeAgentIssueKey("Reduce qualified to execute latency"),
      dedupeKey: buildAgentOpportunityDedupeKey(normalizeAgentIssueKey("Reduce qualified to execute latency")),
      rationale: "Latency optimization has direct R capture impact and reduces decay before execution.",
      createdAt: now,
      status: "OPEN",
    },
    {
      id: `opp-default-signal-freshness-${now}`,
      title: "Improve fresh signal percentage",
      description: "Reduce stale signal carryover and increase freshness entering auto-entry.",
      category: "P1_FUNNEL_OPTIMIZATION",
      priority: "HIGH",
      expectedRImpact: "positive",
      estimatedImpactText: "+0.3R to +0.9R/day",
      confidence: 0.6,
      owner: "performance",
      rootCauseKey: normalizeAgentIssueKey("Eliminate stale signal drag"),
      dedupeKey: buildAgentOpportunityDedupeKey(normalizeAgentIssueKey("Eliminate stale signal drag")),
      rationale: "Fresh signals are more likely to execute at intended prices with better expectancy.",
      createdAt: now,
      status: "OPEN",
    },
    {
      id: `opp-default-kpi-observability-${now}`,
      title: "Harden performance observability",
      description: "Improve KPI quality and telemetry coverage for faster autonomous optimization loops.",
      category: "P4_SYSTEM_QUALITY",
      priority: "MEDIUM",
      expectedRImpact: "neutral",
      estimatedImpactText: "Indirect, improves optimization velocity",
      confidence: 0.55,
      owner: "ops",
      rootCauseKey: normalizeAgentIssueKey("Harden performance observability"),
      dedupeKey: buildAgentOpportunityDedupeKey(normalizeAgentIssueKey("Harden performance observability")),
      rationale: "Better observability shortens diagnosis and remediation loops for revenue-impacting issues.",
      createdAt: now,
      status: "OPEN",
    },
  ];
}

function inferPriorityFromIncident(severity: string): OpportunityPriority {
  const s = String(severity || "").toUpperCase();
  if (s === "CRITICAL") return "CRITICAL";
  if (s === "HIGH") return "HIGH";
  if (s === "MEDIUM") return "MEDIUM";
  return "LOW";
}

function inferRImpactFromIncident(severity: string): ExpectedRImpact {
  const p = inferPriorityFromIncident(severity);
  if (p === "CRITICAL" || p === "HIGH") return "positive";
  return "unknown";
}

function opportunitiesFromKpis(kpis: SharedTradingKpis, now: string): PerformanceOpportunity[] {
  const out: PerformanceOpportunity[] = [];
  const baseline = buildBeforeMetrics(kpis);

  if (kpis.executionLatencySec > 60) {
    out.push({
      id: `opp-latency-${now}`,
      title: "Reduce qualified to execute latency",
      description: `Execution latency is ${kpis.executionLatencySec.toFixed(0)}s; target is < 60s.`,
      category: "P0_TRADING_BLOCKERS",
      priority: kpis.executionLatencySec > 300 ? "CRITICAL" : "HIGH",
      expectedRImpact: "positive",
      estimatedImpactText: "+0.8R to +2.0R/day",
      confidence: clamp01(kpis.executionLatencySec > 300 ? 0.9 : 0.75),
      owner: "execution",
      rootCauseKey: normalizeAgentIssueKey("Reduce qualified to execute latency"),
      dedupeKey: buildAgentOpportunityDedupeKey(normalizeAgentIssueKey("Reduce qualified to execute latency")),
      beforeMetrics: baseline,
      completionRequirements: completionRequirementsFor("Reduce qualified to execute latency"),
      rationale: "High execution latency causes signal decay and worse entry prices.",
      createdAt: now,
      status: "OPEN",
    });
  }

  if (kpis.seededToExecutedPct < 60) {
    out.push({
      id: `opp-seeded-conversion-${now}`,
      title: "Improve seeded to executed conversion",
      description: `Current seeded→executed is ${kpis.seededToExecutedPct.toFixed(0)}%; target is > 60%.`,
      category: "P1_FUNNEL_OPTIMIZATION",
      priority: kpis.seededToExecutedPct < 40 ? "CRITICAL" : "HIGH",
      expectedRImpact: "positive",
      estimatedImpactText: "+0.6R to +1.8R/day",
      confidence: 0.8,
      owner: "execution",
      rootCauseKey: normalizeAgentIssueKey("Improve seeded to executed conversion"),
      dedupeKey: buildAgentOpportunityDedupeKey(normalizeAgentIssueKey("Improve seeded to executed conversion")),
      beforeMetrics: baseline,
      completionRequirements: completionRequirementsFor("Improve seeded to executed conversion"),
      rationale: "Conversion collapse directly reduces realized opportunity capture.",
      createdAt: now,
      status: "OPEN",
    });
  }

  if (kpis.freshSignalPct < 80 || kpis.staleSignalPct > 10) {
    out.push({
      id: `opp-freshness-${now}`,
      title: "Eliminate stale signal drag",
      description: `Fresh=${kpis.freshSignalPct.toFixed(0)}%, stale=${kpis.staleSignalPct.toFixed(0)}%; targets are fresh>80%, stale<10%.`,
      category: "P1_FUNNEL_OPTIMIZATION",
      priority: kpis.freshSignalPct < 50 || kpis.staleSignalPct > 50 ? "CRITICAL" : "HIGH",
      expectedRImpact: "positive",
      estimatedImpactText: "+0.4R to +1.1R/day",
      confidence: 0.7,
      owner: "performance",
      rootCauseKey: normalizeAgentIssueKey("Eliminate stale signal drag"),
      dedupeKey: buildAgentOpportunityDedupeKey(normalizeAgentIssueKey("Eliminate stale signal drag")),
      beforeMetrics: baseline,
      completionRequirements: completionRequirementsFor("Eliminate stale signal drag"),
      rationale: "Signal freshness strongly correlates with valid setup persistence at execution time.",
      createdAt: now,
      status: "OPEN",
    });
  }

  if (kpis.avgRealizedR < 0.3 || kpis.winRate < 0.55) {
    out.push({
      id: `opp-r-quality-${now}`,
      title: "Improve expectancy and R quality",
      description: `avgR=${kpis.avgRealizedR.toFixed(2)}, winRate=${(kpis.winRate * 100).toFixed(0)}%; optimize winner expansion and loser containment.`,
      category: "P2_R_OPTIMIZATION",
      priority: kpis.avgRealizedR < 0 ? "HIGH" : "MEDIUM",
      expectedRImpact: "positive",
      estimatedImpactText: "+0.3R to +1.0R/day",
      confidence: 0.65,
      owner: "pm",
      rootCauseKey: normalizeAgentIssueKey("Improve expectancy and R quality"),
      dedupeKey: buildAgentOpportunityDedupeKey(normalizeAgentIssueKey("Improve expectancy and R quality")),
      beforeMetrics: baseline,
      completionRequirements: completionRequirementsFor("Improve expectancy and R quality"),
      rationale: "Expectancy improvements compound across execution throughput.",
      createdAt: now,
      status: "OPEN",
    });
  }

  if (kpis.scoringSuccessRate < 0.75) {
    out.push({
      id: `opp-throughput-scoring-${now}`,
      title: "Increase scoring throughput reliability",
      description: `Scoring success rate is ${(kpis.scoringSuccessRate * 100).toFixed(0)}%; improve throughput and retry quality.`,
      category: "P3_THROUGHPUT_OPTIMIZATION",
      priority: "MEDIUM",
      expectedRImpact: "positive",
      estimatedImpactText: "+0.2R to +0.6R/day",
      confidence: 0.55,
      owner: "engineering",
      rootCauseKey: normalizeAgentIssueKey("Increase scoring throughput reliability"),
      dedupeKey: buildAgentOpportunityDedupeKey(normalizeAgentIssueKey("Increase scoring throughput reliability")),
      beforeMetrics: baseline,
      completionRequirements: completionRequirementsFor("Increase scoring throughput reliability"),
      rationale: "Throughput bottlenecks suppress candidate flow into profitable execution stages.",
      createdAt: now,
      status: "OPEN",
    });
  }

  if (kpis.brokerErrorRate > 0.1 || kpis.positionMismatchCount > 0) {
    out.push({
      id: `opp-broker-integrity-${now}`,
      title: "Stabilize broker sync and execution integrity",
      description: `brokerErrorRate=${(kpis.brokerErrorRate * 100).toFixed(1)}%, positionMismatchCount=${kpis.positionMismatchCount}.`,
      category: "P0_TRADING_BLOCKERS",
      priority: kpis.brokerErrorRate > 0.1 ? "CRITICAL" : "HIGH",
      expectedRImpact: "positive",
      estimatedImpactText: "Prevents R leakage and missed fills",
      confidence: 0.8,
      owner: "ops",
      rootCauseKey: normalizeAgentIssueKey("Stabilize broker sync and execution integrity"),
      dedupeKey: buildAgentOpportunityDedupeKey(normalizeAgentIssueKey("Stabilize broker sync and execution integrity")),
      beforeMetrics: baseline,
      completionRequirements: completionRequirementsFor("Stabilize broker sync and execution integrity"),
      rationale: "Broker sync integrity is required for reliable autonomous execution.",
      createdAt: now,
      status: "OPEN",
    });
  }

  if (out.length === 0) {
    out.push({
      id: `opp-system-maintenance-${now}`,
      title: "System healthy, optimize diagnostics quality",
      description: "No active blockers detected; prioritize instrumentation and preventive hardening.",
      category: "P4_SYSTEM_QUALITY",
      priority: "MEDIUM",
      expectedRImpact: "neutral",
      estimatedImpactText: "Indirect optimization uplift",
      confidence: 0.5,
      owner: "ops",
      rootCauseKey: normalizeAgentIssueKey("System healthy, optimize diagnostics quality"),
      dedupeKey: buildAgentOpportunityDedupeKey(normalizeAgentIssueKey("System healthy, optimize diagnostics quality")),
      beforeMetrics: baseline,
      completionRequirements: completionRequirementsFor("System healthy, optimize diagnostics quality"),
      rationale: "Healthy state still benefits from proactive diagnostics and maintenance.",
      createdAt: now,
      status: "OPEN",
    });
  }

  return out;
}

function priorityRank(priority: OpportunityPriority): number {
  switch (priority) {
    case "CRITICAL":
      return 0;
    case "HIGH":
      return 1;
    case "MEDIUM":
      return 2;
    default:
      return 3;
  }
}

export function rankOpportunities(opportunities: PerformanceOpportunity[]): PerformanceOpportunity[] {
  return [...opportunities].sort((a, b) => {
    const p = priorityRank(a.priority) - priorityRank(b.priority);
    if (p !== 0) return p;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });
}

export async function generatePerformanceOpportunities(limit = 5): Promise<PerformanceOpportunity[]> {
  const now = nowIso();
  const [openIncidents, kpis] = await Promise.all([
    listOpenIncidents(50).catch(() => []),
    getSharedTradingKpis().catch(() => null),
  ]);

  const baseline = buildBeforeMetrics(kpis);
  const incidentOpportunities: PerformanceOpportunity[] = (openIncidents || []).map((incident) => ({
    id: `opp-incident-${incident.id}`,
    title: incident.title,
    description: incident.summary,
    category: "P0_TRADING_BLOCKERS",
    priority: inferPriorityFromIncident(incident.severity),
    expectedRImpact: inferRImpactFromIncident(incident.severity),
    estimatedImpactText: incident.severity === "CRITICAL" ? "Prevents major R leakage" : "Reduces execution risk",
    confidence: incident.severity === "CRITICAL" ? 0.9 : 0.75,
    owner: incident.source,
    rootCauseKey: normalizeAgentIssueKey(incident.title),
    dedupeKey: buildAgentOpportunityDedupeKey(normalizeAgentIssueKey(incident.title)),
    beforeMetrics: baseline,
    completionRequirements: completionRequirementsFor(incident.title),
    rationale: `${incident.category} incident is open and should be addressed before lower-value work.`,
    createdAt: incident.updatedAt || incident.createdAt || now,
    status: incident.status,
  }));

  const kpiDriven = kpis ? opportunitiesFromKpis(kpis, now) : defaultOpportunities(now);
  const combined = rankOpportunities([...incidentOpportunities, ...kpiDriven]);

  const seen = new Set<string>();
  const unique: PerformanceOpportunity[] = [];
  for (const opp of combined) {
    const key = opp.rootCauseKey || `${opp.title}::${opp.owner}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(opp);
    if (unique.length >= Math.max(1, limit)) break;
  }

  return unique;
}

export async function buildPriorityFeed(limit = 5): Promise<{ priorities: PerformanceOpportunity[]; hasIncidents: boolean; }> {
  const openIncidents = await listOpenIncidents(50).catch(() => []);
  const priorities = await generatePerformanceOpportunities(limit);
  const tasks = await listEngineeringTasks(200).catch(() => []);

  const enrichedPriorities = await Promise.all(priorities.map(async (priority) => {
    const rootCauseKey = priority.rootCauseKey || normalizeAgentIssueKey(priority.title);
    const activeTask = tasks.find((task) => {
      if (task.status === "DONE" || task.status === "FAILED" || task.status === "CANCELED" || task.status === "SUPERSEDED") {
        return false;
      }
      const taskRoot = task.rootCauseKey || normalizeAgentIssueKey(task.title);
      return taskRoot === rootCauseKey;
    });
    const rootState = await readRootCauseExecutionState(rootCauseKey);
    const cooldownUntil = rootState?.cooldownUntil ?? null;
    const cooldownActive = !!cooldownUntil && Date.parse(cooldownUntil) > Date.now();

    return {
      ...priority,
      rootCauseKey,
      dedupeKey: priority.dedupeKey || buildAgentOpportunityDedupeKey(rootCauseKey),
      taskId: activeTask?.id ?? null,
      beforeMetrics: priority.beforeMetrics ?? (activeTask?.beforeMetrics as Record<string, number | null> | undefined),
      cooldownActive,
      cooldownUntil,
    };
  }));

  return {
    priorities: enrichedPriorities,
    hasIncidents: (openIncidents?.length ?? 0) > 0,
  };
}
