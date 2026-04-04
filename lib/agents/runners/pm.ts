import { getEtNowIso } from "@/lib/time/etDate";
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
  const now = getEtNowIso();
  const currentState = await readAgentState();
  const incidents = await listAgentIncidents(50);
  const openIncidents = incidents.filter((incident) => incident.status !== "RESOLVED");

  const nextState: AgentState = {
    ...currentState,
    asOf: now,
    posture: hasHighSeverityIncident(openIncidents) ? "DEFENSIVE" : "NORMAL",
    activeIncidentCount: openIncidents.length,
    updatedBy: "pm",
  };

  const brief: AgentBrief = {
    id: crypto.randomUUID(),
    agent: "pm",
    briefType: "STATUS",
    createdAt: now,
    title: `PM posture ${nextState.posture}`,
    summary:
      nextState.posture === "DEFENSIVE"
        ? `High-severity incidents detected. Posture moved to ${nextState.posture}.`
        : `No high-severity incidents detected. Posture remains ${nextState.posture}.`,
    details: {
      openIncidentCount: openIncidents.length,
      highSeverityOpenCount: openIncidents.filter((incident) => incident.severity === "HIGH").length,
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