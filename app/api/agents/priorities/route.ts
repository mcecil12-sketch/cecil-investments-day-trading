/**
 * GET /api/agents/priorities
 * Returns current ranked priorities for runtime UI.
 * Never returns an empty priorities array: falls back to opportunity engine.
 */
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { checkAgentCronAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import { listOpenIncidents } from "@/lib/agents/store";
import { buildPriorityFeed, type PerformanceOpportunity } from "@/lib/agents/opportunity-engine";

type RuntimePriority = {
  title: string;
  priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  owner: string;
  expectedRImpact: "positive" | "neutral" | "negative" | "unknown";
  estimatedImpactText: string;
  rationale: string;
  status: string;
};

const PRIORITY_WEIGHT: Record<RuntimePriority["priority"], number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

const INCIDENT_CATEGORY_WEIGHT: Record<string, number> = {
  AUTO_ENTRY: 0,
  BROKER_SYNC: 0,
  TRADES: 0,
  FUNNEL_BLOCK: 1,
  SCORING: 2,
  SCANNER: 2,
  ENGINEERING: 3,
  UNKNOWN: 4,
};

function severityToPriority(severity: string): RuntimePriority["priority"] {
  const s = String(severity || "").toUpperCase();
  if (s === "CRITICAL") return "CRITICAL";
  if (s === "HIGH") return "HIGH";
  if (s === "MEDIUM") return "MEDIUM";
  return "LOW";
}

function incidentToPriority(incident: any): RuntimePriority {
  const priority = severityToPriority(incident?.severity);
  return {
    title: String(incident?.title || "Open incident"),
    priority,
    severity: priority,
    owner: String(incident?.source || "ops"),
    expectedRImpact: priority === "CRITICAL" || priority === "HIGH" ? "positive" : "unknown",
    estimatedImpactText: priority === "CRITICAL" ? "Prevents major R leakage" : "Reduces execution/funnel risk",
    rationale: `${String(incident?.category || "UNKNOWN")} incident remains open and should be resolved before lower-priority optimization work.`,
    status: String(incident?.status || "OPEN"),
  };
}

function rankIncidentPriorities(priorities: RuntimePriority[], incidents: any[]): RuntimePriority[] {
  const paired = priorities.map((priority, idx) => {
    const incident = incidents[idx] ?? null;
    const category = String(incident?.category || "UNKNOWN").toUpperCase();
    const categoryWeight = INCIDENT_CATEGORY_WEIGHT[category] ?? INCIDENT_CATEGORY_WEIGHT.UNKNOWN;
    const updatedAt = Date.parse(String(incident?.updatedAt || incident?.createdAt || ""));
    return {
      priority,
      priorityWeight: PRIORITY_WEIGHT[priority.priority],
      categoryWeight,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    };
  });

  return paired
    .sort((a, b) => {
      if (a.priorityWeight !== b.priorityWeight) return a.priorityWeight - b.priorityWeight;
      if (a.categoryWeight !== b.categoryWeight) return a.categoryWeight - b.categoryWeight;
      return b.updatedAt - a.updatedAt;
    })
    .map((row) => row.priority);
}

function opportunityToPriority(opp: PerformanceOpportunity): RuntimePriority {
  return {
    title: opp.title,
    priority: opp.priority,
    severity: opp.priority,
    owner: opp.owner,
    expectedRImpact: opp.expectedRImpact,
    estimatedImpactText: opp.estimatedImpactText,
    rationale: opp.rationale,
    status: opp.status,
  };
}

export async function GET(req: Request) {
  const auth = checkAgentCronAuth(req);
  if (!auth.ok) return unauthorizedAgentResponse(auth.error);

  const url = new URL(req.url);
  const limitParam = Number(url.searchParams.get("limit") ?? "5");
  const limit = Number.isFinite(limitParam) && limitParam > 0
    ? Math.min(25, Math.floor(limitParam))
    : 5;

  const [openIncidents, priorityFeed] = await Promise.all([
    listOpenIncidents(50).catch(() => []),
    buildPriorityFeed(Math.max(5, limit)).catch(() => ({ priorities: [] as PerformanceOpportunity[], hasIncidents: false })),
  ]);

  const fromIncidents = (openIncidents || []).map(incidentToPriority);
  const fromOpportunities = (priorityFeed.priorities || []).map(opportunityToPriority);
  const rankedIncidentPriorities = rankIncidentPriorities(fromIncidents, openIncidents || []);

  const priorities = (fromOpportunities.length > 0 ? fromOpportunities : rankedIncidentPriorities).slice(0, limit);

  // Absolute non-empty guarantee
  const guaranteedPriorities: RuntimePriority[] =
    priorities.length > 0
      ? priorities
      : [
          {
            title: "System healthy, continue execution optimization",
            priority: "MEDIUM",
            severity: "MEDIUM",
            owner: "engineering-manager",
            expectedRImpact: "neutral",
            estimatedImpactText: "Maintain reliability and improve throughput",
            rationale: "No open incidents detected; keep autonomous optimization loop active.",
            status: "OPEN",
          },
        ];

  return NextResponse.json({
    ok: true,
    priorityCount: guaranteedPriorities.length,
    priorities: guaranteedPriorities,
    source: "priority_feed",
    hasOpenIncidents: fromIncidents.length > 0,
  });
}
