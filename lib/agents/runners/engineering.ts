import {
  appendAgentAction,
  appendAgentBrief,
  listAgentIncidents,
  listEngineeringTasks,
  readAgentState,
  updateEngineeringTaskById,
  upsertEngineeringTask,
  writeAgentState,
} from "@/lib/agents/store";
import { classifyIncident } from "@/lib/agents/incidents";
import { nowIso } from "@/lib/agents/time";
import type {
  AgentBrief,
  AgentIncident,
  AgentRunnerResult,
  EngineeringTask,
} from "@/lib/agents/types";

// ---------------------------------------------------------------------------
// Task builders — incident-specific, rich context
// ---------------------------------------------------------------------------

function buildTaskTitle(incident: AgentIncident): string {
  switch (incident.category) {
    case "BROKER_SYNC":
      return "Resolve broker/DB open-trade mismatch for stale OPEN trades";
    case "SCORING":
      return "Investigate scoring pipeline stall";
    case "SCANNER":
      return "Investigate stale scanner during market window";
    case "AUTO_ENTRY":
      return "Investigate auto-entry disabled / blocked";
    case "TRADES":
      return "Investigate trade lifecycle anomaly";
    default:
      return `Investigate ${incident.category.toLowerCase()} incident`;
  }
}

function parseBrokerDbCounts(summary: string): { brokerPositionsCount: number | null; dbOperationalOpenCount: number | null } {
  const brokerMatch = summary.match(/Broker positions=(\d+)/i);
  const dbMatch = summary.match(/DB operational open=(\d+)/i);
  return {
    brokerPositionsCount: brokerMatch ? Number(brokerMatch[1]) : null,
    dbOperationalOpenCount: dbMatch ? Number(dbMatch[1]) : null,
  };
}

function buildCopilotPrompt(incident: AgentIncident, classification: ReturnType<typeof classifyIncident>): string {
  if (incident.category === "BROKER_SYNC") {
    const { brokerPositionsCount, dbOperationalOpenCount } = parseBrokerDbCounts(incident.summary);
    const observedCounts =
      brokerPositionsCount !== null || dbOperationalOpenCount !== null
        ? `Broker positions=${brokerPositionsCount ?? "unknown"}, DB operational open=${dbOperationalOpenCount ?? "unknown"}.`
        : "Broker/DB counts unavailable in incident summary.";
    return (
      `Incident ${incident.id} — BROKER_SYNC mismatch detected in the Cecil Trading App.\n\n` +
      `Observed: ${incident.summary}\n\n` +
      `Counts snapshot: ${observedCounts}\n\n` +
      `Root cause hypothesis: ${classification.likelyRootCause}\n\n` +
      `Review these files first:\n` +
      [...classification.likelyFiles, "lib/maintenance/reconcileOpenTrades.ts", "app/api/maintenance/sync-broker-state/route.ts", "app/api/maintenance/finalize-closes/route.ts"]
        .map((f) => `  - ${f}`)
        .join("\n") + "\n\n" +
      `Key questions:\n` +
      `  1. Are there operationally-open DB trades (including broker/alpaca position_open markers) that are missing at the broker?\n` +
      `  2. Does reconcileOpenTrades use the same open-trade definition as countOperationalOpenTickers?\n` +
      `  3. Does sync-broker-state handle stale/ghost positions without re-opening already-closed trades?\n` +
      `  4. Does fetchBrokerTruth return accurate positionsCount and cache behavior under retries?\n\n` +
      `Apply the smallest safe fix. Preserve scan -> signals -> scoring -> auto-entry behavior.`
    );
  }
  if (incident.category === "SCORING") {
    return (
      `Incident ${incident.id} — SCORING stall detected in the Cecil Trading App.\n\n` +
      `Observed: ${incident.summary}\n\n` +
      `Root cause hypothesis: ${classification.likelyRootCause}\n\n` +
      `Review these files first:\n` +
      classification.likelyFiles.map((f) => `  - ${f}`).join("\n") + "\n\n" +
      `Key questions:\n` +
      `  1. Is the score drain route being invoked on schedule?\n` +
      `  2. Is there an AI quota or timeout issue?\n` +
      `  3. Are signals stuck in PENDING/SCORING status?\n\n` +
      `Apply the smallest safe fix. Do not modify broker execution logic.`
    );
  }
  if (incident.category === "AUTO_ENTRY") {
    return (
      `Incident ${incident.id} — AUTO_ENTRY disabled in the Cecil Trading App.\n\n` +
      `Observed: ${incident.summary}\n\n` +
      `Root cause hypothesis: ${classification.likelyRootCause}\n\n` +
      `Review these files first:\n` +
      classification.likelyFiles.map((f) => `  - ${f}`).join("\n") + "\n\n" +
      `Key questions:\n` +
      `  1. What guardrail or toggle caused the disable?\n` +
      `  2. Is there a daily loss limit active?\n` +
      `  3. What are the safe reset conditions?\n\n` +
      `Do not auto-reset without verifying root cause. Preserve all execution guards.`
    );
  }
  const likelyFilesText = classification.likelyFiles.map((f) => `  - ${f}`).join("\n");
  return (
    `Incident ${incident.id} (${incident.category}) in the Cecil Trading App.\n\n` +
    `Observed: ${incident.summary}\n\n` +
    `Root cause hypothesis: ${classification.likelyRootCause}\n\n` +
    `Review these files first:\n${likelyFilesText}\n\n` +
    `Apply the smallest safe fix. Preserve scan -> signals -> scoring -> auto-entry behavior.`
  );
}

function buildSmokeTestBlock(incident: AgentIncident): string {
  const common = `npm run build\nnpm run test -- --runInBand`;
  if (incident.category === "BROKER_SYNC") {
    return (
      `${common}\n` +
      `# Then verify:\n` +
      `# GET /api/agents/run?agent=ops\n` +
      `# GET /api/agents/incidents\n` +
      `# GET /api/ops/status   (check broker.positionsCount vs trades.operationalOpen)\n` +
      `# GET /api/readiness    (verify open-trade mismatch cleared)\n` +
      `# POST /api/maintenance/reconcile-open-trades  (dry-run first)\n` +
      `# POST /api/maintenance/sync-broker-state\n` +
      `# POST /api/maintenance/finalize-closes`
    );
  }
  if (incident.category === "SCORING") {
    return (
      `${common}\n` +
      `# Then verify:\n` +
      `# GET /api/agents/run?agent=ops\n` +
      `# GET /api/readiness\n` +
      `# GET /api/ops/status   (check scoring.age, signals pipeline)`
    );
  }
  return (
    `${common}\n` +
    `# Then verify:\n` +
    `# GET /api/agents/run?agent=ops\n` +
    `# GET /api/agents/incidents\n` +
    `# GET /api/readiness`
  );
}

function buildTask(incident: AgentIncident, now: string): EngineeringTask {
  const classification = classifyIncident(incident);
  const title = buildTaskTitle(incident);
  const { brokerPositionsCount, dbOperationalOpenCount } = parseBrokerDbCounts(incident.summary);
  const summary =
    `[${incident.severity}][${incident.category}] ${incident.title}. ` +
    `${incident.summary} ` +
    `Recommended next action: ${classification.recommendedNextAction}`;
  const commitSummary = `agent: investigate ${incident.category.toLowerCase()} incident`;

  return {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    status: "OPEN",
    title,
    summary,
    likelyFiles: classification.likelyFiles,
    copilotPrompt: buildCopilotPrompt(incident, classification),
    smokeTestBlock: buildSmokeTestBlock(incident),
    gitBlock: `git add -A && git commit -m "${commitSummary}" && git push`,
    incidentId: incident.id,
    incidentCategory: incident.category,
    likelyRootCause: classification.likelyRootCause,
    recommendedNextAction: classification.recommendedNextAction,
    remediationAttempted: false,
    remediationStatus: "none",
    successCriteria:
      incident.category === "BROKER_SYNC"
        ? "Broker positions count and DB operational open count reconcile with no mismatch. Stale open-position markers are cleaned up, incident resolves, and readiness no longer reports an open-trade mismatch."
        : undefined,
    linkedTelemetrySnapshot:
      incident.category === "BROKER_SYNC" &&
      (brokerPositionsCount !== null || dbOperationalOpenCount !== null)
        ? {
          brokerPositionsCount,
          dbOperationalOpenCount,
          incidentSeverity: incident.severity,
        }
        : undefined,
    remediationResultSummary:
      incident.category === "BROKER_SYNC" && incident.status === "MONITORING"
        ? incident.summary
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export async function runEngineeringAgent(): Promise<AgentRunnerResult> {
  const now = nowIso();
  const currentState = await readAgentState();
  const incidents = await listAgentIncidents(50);
  const tasks = await listEngineeringTasks(50);

  // Close stale BROKER_SYNC tasks when their linked incident has already resolved.
  let resolvedTaskUpdates = 0;
  for (const task of tasks) {
    if (
      task.incidentCategory === "BROKER_SYNC" &&
      task.incidentId &&
      (task.status === "OPEN" || task.status === "IN_PROGRESS" || task.status === "READY_FOR_REVIEW")
    ) {
      const linkedIncident = incidents.find((incident) => incident.id === task.incidentId);
      if (linkedIncident?.status === "RESOLVED") {
        const updated = await updateEngineeringTaskById(task.id, {
          status: "DONE",
          remediationStatus: "succeeded",
          remediationAttempted: true,
          remediationResultSummary:
            linkedIncident.summary || "BROKER_SYNC incident resolved; task closed as no longer actionable.",
        });
        if (updated) {
          resolvedTaskUpdates += 1;
        }
      }
    }
  }

  // Find the highest-priority incident that needs a task: OPEN or MONITORING,
  // HIGH or MEDIUM severity, not yet linked to an open engineering task.
  const candidate = incidents.find(
    (incident) =>
      (incident.status === "OPEN" || incident.status === "MONITORING") &&
      (incident.severity === "HIGH" || incident.severity === "MEDIUM") &&
      !tasks.find(
        (task) =>
          task.incidentId === incident.id &&
          (task.status === "OPEN" || task.status === "IN_PROGRESS" || task.status === "READY_FOR_REVIEW"),
      ),
  );

  let createdTaskId: string | null = null;
  let upsertCreated = false;
  let updatedTaskId: string | null = null;

  if (candidate) {
    const nextTask = buildTask(candidate, now);
    const upsertResult = await upsertEngineeringTask(nextTask);
    createdTaskId = upsertResult.created ? upsertResult.task.id : null;
    upsertCreated = upsertResult.created;
  }

  const monitoringBrokerIncident = incidents.find(
    (incident) => incident.category === "BROKER_SYNC" && incident.status === "MONITORING",
  );
  if (monitoringBrokerIncident) {
    const existingTask = tasks.find(
      (task) =>
        task.incidentId === monitoringBrokerIncident.id &&
        (task.status === "OPEN" || task.status === "IN_PROGRESS" || task.status === "READY_FOR_REVIEW"),
    );
    if (existingTask) {
      const { brokerPositionsCount, dbOperationalOpenCount } = parseBrokerDbCounts(monitoringBrokerIncident.summary);
      const updated = await updateEngineeringTaskById(existingTask.id, {
        remediationAttempted: true,
        remediationStatus: "attempted",
        remediationResultSummary: monitoringBrokerIncident.summary,
        linkedTelemetrySnapshot:
          brokerPositionsCount !== null || dbOperationalOpenCount !== null
            ? {
              brokerPositionsCount,
              dbOperationalOpenCount,
              incidentSeverity: monitoringBrokerIncident.severity,
            }
            : undefined,
      });
      if (updated) {
        updatedTaskId = updated.id;
      }
    }
  }

  const refreshedTasks = await listEngineeringTasks(50);
  const openTasks = refreshedTasks.filter(
    (task) => task.status === "OPEN" || task.status === "IN_PROGRESS" || task.status === "READY_FOR_REVIEW",
  );
  const openTaskCount = openTasks.length;

  const taskSummary = upsertCreated
    ? `Created engineering task "${buildTaskTitle(candidate!)}" for incident ${candidate!.id}.`
    : resolvedTaskUpdates > 0
      ? `Closed ${resolvedTaskUpdates} resolved BROKER_SYNC engineering task${resolvedTaskUpdates === 1 ? "" : "s"}.`
      : "No new engineering task was needed.";

  const latestTask = upsertCreated && candidate
    ? buildTaskTitle(candidate)
    : (openTasks[0]?.title ?? currentState.latestEngineeringTaskTitle ?? null);

  const brief: AgentBrief = {
    id: crypto.randomUUID(),
    agent: "engineering",
    briefType: "STATUS",
    createdAt: now,
    title: upsertCreated ? "Engineering task queued" : "Engineering backlog unchanged",
    summary: `${taskSummary} Open tasks: ${openTaskCount}.`,
    details: {
      createdTaskId,
      candidateIncidentId: candidate?.id ?? null,
      openTaskCount,
    },
  };

  await appendAgentBrief(brief);

  const savedState = await writeAgentState({
    ...currentState,
    asOf: now,
    latestBriefId: brief.id,
    latestEngineeringTaskId: createdTaskId ?? currentState.latestEngineeringTaskId ?? null,
    latestEngineeringTaskTitle: latestTask,
    openEngineeringTaskCount: openTaskCount,
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
      createdTaskId,
      updatedTaskId,
      incidentId: candidate?.id ?? null,
    },
  });

  return {
    agent: "engineering",
    state: savedState,
    briefId: brief.id,
    actionId: action.id,
    engineeringTaskId: createdTaskId,
    summary: brief.summary,
  };
}