import { nowIso } from "@/lib/agents/time";
import {
  appendAgentAction,
  appendAgentBrief,
  listAgentIncidents,
  readAgentState,
  writeAgentState,
} from "@/lib/agents/store";
import type { AgentBrief, AgentIncident, AgentRunnerResult, AgentState } from "@/lib/agents/types";

function hasHighSeverityIncident(incidents: AgentIncident[]): boolean {
  return incidents.some((incident) => incident.status !== "RESOLVED" && incident.severity === "HIGH");
}

export async function runPmAgent(): Promise<AgentRunnerResult> {
  const now = nowIso();
  const currentState = await readAgentState();
  const incidents = await listAgentIncidents(50);
  const openIncidents = incidents.filter((incident) => incident.status !== "RESOLVED");
  const hasHighIncident = hasHighSeverityIncident(openIncidents);

  const reasons: string[] = [];
  if (hasHighIncident) reasons.push("high-severity incident open");
  if (currentState.eventRisk === "HIGH") reasons.push("event risk HIGH");
  if (currentState.telemetry?.readinessReady === false) {
    reasons.push(...(currentState.telemetry?.readinessReasons ?? ["readiness degraded"]));
  }

  const shouldDefend = reasons.length > 0;
  const baseRestrictions = (currentState.activeRestrictions ?? []).filter((value) => !value.startsWith("PM: "));
  const pmRestrictions = shouldDefend
    ? Array.from(new Set(reasons.map((reason) => `PM: ${reason}`)))
    : [];

  const nextState: AgentState = {
    ...currentState,
    asOf: now,
    posture: shouldDefend ? "DEFENSIVE" : "NORMAL",
    activeRestrictions: [...pmRestrictions, ...baseRestrictions],
    activeIncidentCount: openIncidents.length,
    updatedBy: "pm",
  };

  const brief: AgentBrief = {
    id: crypto.randomUUID(),
    agent: "pm",
    briefType: "STATUS",
    createdAt: now,
    title: `PM posture ${nextState.posture}`,
    summary: shouldDefend
      ? `Posture moved to DEFENSIVE due to: ${reasons.join("; ")}.`
      : "Posture remains NORMAL. No high-risk incidents or readiness degradation detected.",
    details: {
      openIncidentCount: openIncidents.length,
      highSeverityOpenCount: openIncidents.filter((incident) => incident.severity === "HIGH").length,
      reasons,
      activeRestrictions: nextState.activeRestrictions,
    },
  };

  await appendAgentBrief(brief);

  const savedState = await writeAgentState({
    ...nextState,
    latestBriefId: brief.id,
  });

  const action = await appendAgentAction({
    id: crypto.randomUUID(),
    createdAt: now,
    agent: "pm",
    actionType: "POSTURE_REVIEW",
    status: "APPLIED",
    summary: `PM set posture to ${savedState.posture}.`,
    metadata: {
      activeIncidentCount: savedState.activeIncidentCount,
    },
  });

  return {
    agent: "pm",
    state: savedState,
    briefId: brief.id,
    actionId: action.id,
    summary: brief.summary,
  };
}