import {
  type AgentStateSnapshot,
  appendAgentAction,
  appendAgentBrief,
  appendAgentIncident,
  listAgentActions,
  listAgentIncidents,
  readAgentStateSnapshot,
  writeAgentState,
} from "@/lib/agents/store";
import { getEtNowIso } from "@/lib/time/etDate";
import type { AgentBrief, AgentIncident, AgentRunnerResult } from "@/lib/agents/types";

function summarizeOps(snapshot: AgentStateSnapshot, incidents: AgentIncident[], actionCount: number): string {
  if (snapshot.source === "invalid") {
    return "State storage looked malformed. Logged a low-severity ops incident for follow-up.";
  }

  const openCount = incidents.filter((incident) => incident.status !== "RESOLVED").length;
  if (openCount === 0) {
    return `Ops is healthy. No major incidents are active across ${actionCount} recent control-plane actions.`;
  }

  return `Ops is tracking ${openCount} active incident${openCount === 1 ? "" : "s"}.`;
}

export async function runOpsAgent(): Promise<AgentRunnerResult> {
  const now = getEtNowIso();
  const snapshot = await readAgentStateSnapshot();
  let incidents = await listAgentIncidents(50);
  const actions = await listAgentActions(50);
  let createdIncidentId: string | null = null;

  if (snapshot.source === "invalid") {
    const incident = await appendAgentIncident({
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      severity: "LOW",
      source: "ops",
      category: "UNKNOWN",
      status: "OPEN",
      title: "Agent state required recovery",
      summary: "The stored agent state was malformed and was replaced with safe defaults.",
      notes: ["Day-1 ops runner detected invalid control-plane state."],
    });
    createdIncidentId = incident.id;
    incidents = [incident, ...incidents];
  }

  const activeIncidentCount = incidents.filter((incident) => incident.status !== "RESOLVED").length;
  const brief: AgentBrief = {
    id: crypto.randomUUID(),
    agent: "ops",
    briefType: "STATUS",
    createdAt: now,
    title: activeIncidentCount === 0 ? "Ops healthy" : `Ops tracking ${activeIncidentCount} incident${activeIncidentCount === 1 ? "" : "s"}`,
    summary: summarizeOps(snapshot, incidents, actions.length),
    details: {
      stateSource: snapshot.source,
      activeIncidentCount,
      recentActionCount: actions.length,
    },
  };

  await appendAgentBrief(brief);

  const savedState = await writeAgentState({
    ...snapshot.state,
    asOf: now,
    activeIncidentCount,
    latestBriefId: brief.id,
    updatedBy: "ops",
  });

  const action = await appendAgentAction({
    id: crypto.randomUUID(),
    createdAt: now,
    agent: "ops",
    actionType: "HEALTH_SUMMARY",
    status: "APPLIED",
    summary: `Ops recorded ${activeIncidentCount} active incidents.`,
    metadata: {
      stateSource: snapshot.source,
      createdIncidentId,
    },
  });

  return {
    agent: "ops",
    state: savedState,
    briefId: brief.id,
    actionId: action.id,
    incidentId: createdIncidentId,
    summary: brief.summary,
  };
}