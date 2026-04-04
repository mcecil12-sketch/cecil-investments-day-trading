import { createDefaultAgentState, appendAgentAction, appendAgentBrief, readAgentState, writeAgentState } from "@/lib/agents/store";
import { getEtNowIso } from "@/lib/time/etDate";
import type { AgentBrief, AgentRunnerResult, AgentState } from "@/lib/agents/types";

const RISK_TIGHTEN_RESTRICTION = "Risk tightened to A/B only";

function nextRestrictions(state: AgentState): string[] {
  const base = state.activeRestrictions.filter((value) => value !== RISK_TIGHTEN_RESTRICTION);
  if (state.posture !== "DEFENSIVE") return base;
  return [RISK_TIGHTEN_RESTRICTION, ...base];
}

export async function runRiskAgent(): Promise<AgentRunnerResult> {
  const now = getEtNowIso();
  const currentState = await readAgentState();
  const defaults = createDefaultAgentState(now);

  const nextState: AgentState = {
    ...currentState,
    asOf: now,
    allowedGrades: currentState.posture === "DEFENSIVE" ? ["A", "B"] : defaults.allowedGrades,
    activeRestrictions: nextRestrictions(currentState),
    updatedBy: "risk",
  };

  const brief: AgentBrief = {
    id: crypto.randomUUID(),
    agent: "risk",
    briefType: "STATUS",
    createdAt: now,
    title: `Risk guard ${nextState.posture}`,
    summary:
      nextState.posture === "DEFENSIVE"
        ? "Risk tightened eligibility to A/B only while the desk is defensive."
        : `Risk remains aligned with baseline grades ${nextState.allowedGrades.join("/")}.`,
    details: {
      allowedGrades: nextState.allowedGrades,
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
    agent: "risk",
    actionType: "RISK_ALIGNMENT",
    status: "APPLIED",
    summary: `Risk set allowed grades to ${savedState.allowedGrades.join("/")}.`,
    metadata: {
      posture: savedState.posture,
      activeRestrictions: savedState.activeRestrictions,
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