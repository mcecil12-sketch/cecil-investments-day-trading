import { appendAgentAction, appendAgentBrief, readAgentState, writeAgentState } from "@/lib/agents/store";
import { nowIso } from "@/lib/agents/time";
import type { AgentBrief, AgentRunnerResult, AgentState, EventRisk, NewsState } from "@/lib/agents/types";

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function getEventPosture(now: Date): { eventRisk: EventRisk; newsState: NewsState; nearOpen: boolean } {
  const parts = ET_PARTS.formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value ?? "Sun";
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday);
  const minutesAfterMidnight = hour * 60 + minute;
  const nearOpen = isWeekday && minutesAfterMidnight >= 9 * 60 && minutesAfterMidnight <= 10 * 60 + 30;

  return {
    eventRisk: nearOpen ? "MEDIUM" : "LOW",
    newsState: nearOpen ? "ACTIVE" : "CALM",
    nearOpen,
  };
}

export async function runPolicyNewsAgent(): Promise<AgentRunnerResult> {
  const nowDate = new Date();
  const now = nowIso();
  const currentState = await readAgentState();
  const policy = getEventPosture(nowDate);

  const nextState: AgentState = {
    ...currentState,
    asOf: now,
    eventRisk: policy.eventRisk,
    newsState: policy.newsState,
    updatedBy: "policynews",
  };

  const brief: AgentBrief = {
    id: crypto.randomUUID(),
    agent: "policynews",
    briefType: "STATUS",
    createdAt: now,
    title: `Policy/news ${nextState.eventRisk}`,
    summary: policy.nearOpen
      ? "Near the market open, event risk is held at MEDIUM and news state is ACTIVE."
      : "No macro escalation inferred. Event risk stays LOW and news state stays CALM.",
    details: {
      eventRisk: nextState.eventRisk,
      newsState: nextState.newsState,
      nearOpen: policy.nearOpen,
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
    agent: "policynews",
    actionType: "EVENT_RISK_UPDATE",
    status: "APPLIED",
    summary: `Policy/news set event risk ${savedState.eventRisk} and news state ${savedState.newsState}.`,
    metadata: {
      nearOpen: policy.nearOpen,
    },
  });

  return {
    agent: "policynews",
    state: savedState,
    briefId: brief.id,
    actionId: action.id,
    summary: brief.summary,
  };
}