import {
  createDefaultAgentState,
  appendAgentAction,
  appendAgentBrief,
  listOpenIncidents,
  readAgentState,
  writeAgentState,
} from "@/lib/agents/store";
import { nowIso } from "@/lib/agents/time";
import type { AgentBrief, AgentIncident, AgentRunnerResult, AgentState, AllowedGrade } from "@/lib/agents/types";

const RISK_TIGHTEN_RESTRICTION = "Risk tightened to A/B only";
const RISK_HIGH_RESTRICTION = "Risk tightened to A-only due to severe incident";
const RISK_EVENT_RESTRICTION = "Risk tightened due to elevated event risk";

export async function runRiskAgent(): Promise<AgentRunnerResult> {
  const now = nowIso();
  const currentState = await readAgentState();
  const openIncidents = await listOpenIncidents(50);
  const defaults = createDefaultAgentState(now);

  const hasCriticalExecutionIncident = openIncidents.some(
    (incident: AgentIncident) =>
      incident.severity === "HIGH" &&
      ["SCORING", "AUTO_ENTRY", "TRADES", "BROKER_SYNC"].includes(incident.category)
  );

  let allowedGrades: AllowedGrade[] = defaults.allowedGrades;
  let minScoreAdjustment = 0;
  const reasons: string[] = [];

  if (hasCriticalExecutionIncident) {
    allowedGrades = ["A"];
    minScoreAdjustment = 0.5;
    reasons.push(RISK_HIGH_RESTRICTION);
  } else if (currentState.posture === "DEFENSIVE") {
    allowedGrades = ["A", "B"];
    minScoreAdjustment = 0.5;
    reasons.push(RISK_TIGHTEN_RESTRICTION);
  } else {
    allowedGrades = defaults.allowedGrades;
  }

  if (currentState.eventRisk === "HIGH") {
    if (!reasons.includes(RISK_EVENT_RESTRICTION)) reasons.push(RISK_EVENT_RESTRICTION);
    if (minScoreAdjustment < 0.5) minScoreAdjustment = 0.5;
    if (allowedGrades.includes("C")) {
      allowedGrades = ["A", "B"];
    }
  }

  const priorNonRiskRestrictions = currentState.activeRestrictions.filter(
    (value) =>
      value !== RISK_TIGHTEN_RESTRICTION &&
      value !== RISK_HIGH_RESTRICTION &&
      value !== RISK_EVENT_RESTRICTION
  );

  const nextState: AgentState = {
    ...currentState,
    asOf: now,
    allowedGrades,
    minScoreAdjustment,
    activeRestrictions: [...reasons, ...priorNonRiskRestrictions],
    updatedBy: "risk",
  };

  const brief: AgentBrief = {
    id: crypto.randomUUID(),
    agent: "risk",
    briefType: "STATUS",
    createdAt: now,
    title: `Risk guard ${nextState.posture}`,
    summary:
      reasons.length > 0
        ? `Risk tightened to ${nextState.allowedGrades.join("/")} with +${nextState.minScoreAdjustment.toFixed(1)} score adjustment. Reasons: ${reasons.join("; ")}.`
        : `Risk remains aligned with baseline grades ${nextState.allowedGrades.join("/")} with no score adjustment.`,
    details: {
      allowedGrades: nextState.allowedGrades,
      activeRestrictions: nextState.activeRestrictions,
      minScoreAdjustment: nextState.minScoreAdjustment,
      openIncidentCount: openIncidents.length,
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
    agent: "risk",
    actionType: "RISK_ALIGNMENT",
    status: "APPLIED",
    summary: `Risk set allowed grades to ${savedState.allowedGrades.join("/")} (minScoreAdjustment=${savedState.minScoreAdjustment.toFixed(1)}).`,
    metadata: {
      posture: savedState.posture,
      activeRestrictions: savedState.activeRestrictions,
      reasons,
    },
  });

  return {
    agent: "risk",
    state: savedState,
    briefId: brief.id,
    actionId: action.id,
    summary: brief.summary,
  };
}