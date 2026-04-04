import {
  appendAgentAction,
  appendAgentBrief,
  appendEngineeringTask,
  listAgentIncidents,
  listEngineeringTasks,
  readAgentState,
  writeAgentState,
} from "@/lib/agents/store";
import { getEtNowIso } from "@/lib/time/etDate";
import type {
  AgentBrief,
  AgentIncident,
  AgentIncidentCategory,
  AgentRunnerResult,
  EngineeringTask,
} from "@/lib/agents/types";

function likelyFilesForCategory(category: AgentIncidentCategory): string[] {
  switch (category) {
    case "SCORING":
      return [
        "app/api/ai/score/drain/route.ts",
        "lib/aiScoring.ts",
        "lib/ai/scoreDrainApply.ts",
      ];
    case "SCANNER":
      return [
        "app/api/readiness/route.ts",
        "app/api/ops/status/route.ts",
        "lib/funnelRedis.ts",
      ];
    case "AUTO_ENTRY":
      return [
        "app/api/auto-entry/execute/route.ts",
        "lib/autoEntry/engine.ts",
        "lib/autoEntry/guardrails.ts",
      ];
    case "TRADES":
      return [
        "app/api/trades/approve/route.ts",
        "lib/tradesStore.ts",
        "lib/trades/canonical.ts",
      ];
    case "BROKER_SYNC":
      return [
        "app/api/maintenance/sync-broker-state/route.ts",
        "lib/broker/truth.ts",
        "lib/alpacaClock.ts",
      ];
    case "NEWS":
      return [
        "lib/agents/runners/policyNews.ts",
        "lib/agents/store.ts",
        "app/api/agents/state/route.ts",
      ];
    case "ENGINEERING":
      return [
        "lib/agents/runners/engineering.ts",
        "app/api/agents/run/route.ts",
        "components/AgentControlCard.tsx",
      ];
    case "UNKNOWN":
    default:
      return [
        "app/api/ops/status/route.ts",
        "lib/agents/store.ts",
        "app/api/agents/run/route.ts",
      ];
  }
}

function openEngineeringTaskForIncident(tasks: EngineeringTask[], incidentId: string): EngineeringTask | null {
  return (
    tasks.find(
      (task) =>
        task.incidentId === incidentId &&
        (task.status === "OPEN" || task.status === "IN_PROGRESS" || task.status === "READY_FOR_REVIEW")
    ) ?? null
  );
}

function buildTask(incident: AgentIncident, now: string): EngineeringTask {
  const likelyFiles = likelyFilesForCategory(incident.category);
  const title = `Investigate ${incident.category.toLowerCase()} incident`;
  const summary = `${incident.severity} incident from ${incident.source}: ${incident.title}. ${incident.summary}`;
  const commitSummary = `agent: address ${incident.category.toLowerCase()} incident`;

  return {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    status: "OPEN",
    title,
    summary,
    likelyFiles,
    copilotPrompt: `Investigate incident ${incident.id} (${incident.category}) in the Cecil Trading App. Review ${likelyFiles.join(", ")} first, explain the likely fault, apply the smallest safe fix, and preserve existing scan -> signals -> scoring -> auto-entry behavior.`,
    smokeTestBlock: `npm run build\nnpm run test -- --runInBand`,
    gitBlock: `git add -A && git commit -m "${commitSummary}" && git push`,
    incidentId: incident.id,
  };
}

export async function runEngineeringAgent(): Promise<AgentRunnerResult> {
  const now = getEtNowIso();
  const currentState = await readAgentState();
  const incidents = await listAgentIncidents(50);
  const tasks = await listEngineeringTasks(50);

  const candidate = incidents.find(
    (incident) =>
      incident.status === "OPEN" &&
      (incident.severity === "HIGH" || incident.severity === "MEDIUM") &&
      !openEngineeringTaskForIncident(tasks, incident.id)
  );

  const createdTask = candidate ? await appendEngineeringTask(buildTask(candidate, now)) : null;
  const openTasks = tasks.filter((task) => task.status !== "DONE");
  const taskSummary = createdTask
    ? `Created engineering task for incident ${candidate?.id}.`
    : "No new engineering task was needed.";

  const brief: AgentBrief = {
    id: crypto.randomUUID(),
    agent: "engineering",
    briefType: "STATUS",
    createdAt: now,
    title: createdTask ? "Engineering task queued" : "Engineering backlog unchanged",
    summary: `${taskSummary} Open tasks: ${createdTask ? openTasks.length + 1 : openTasks.length}.`,
    details: {
      createdTaskId: createdTask?.id ?? null,
      candidateIncidentId: candidate?.id ?? null,
      openTaskCount: createdTask ? openTasks.length + 1 : openTasks.length,
    },
  };

  await appendAgentBrief(brief);

  const savedState = await writeAgentState({
    ...currentState,
    asOf: now,
    latestBriefId: brief.id,
    latestEngineeringTaskId: createdTask?.id ?? currentState.latestEngineeringTaskId ?? null,
    updatedBy: "engineering",
  });

  const action = await appendAgentAction({
    id: crypto.randomUUID(),
    createdAt: now,
    agent: "engineering",
    actionType: "ENGINEERING_TRIAGE",
    status: "APPLIED",
    summary: taskSummary,
    metadata: {
      createdTaskId: createdTask?.id ?? null,
      incidentId: candidate?.id ?? null,
    },
  });

  return {
    agent: "engineering",
    state: savedState,
    briefId: brief.id,
    actionId: action.id,
    engineeringTaskId: createdTask?.id ?? null,
    summary: brief.summary,
  };
}