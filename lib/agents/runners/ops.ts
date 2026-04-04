import {
  type AgentStateSnapshot,
  appendAgentAction,
  appendAgentBrief,
  listAgentActions,
  listOpenIncidents,
  readAgentStateSnapshot,
  resolveIncident,
  upsertIncident,
  writeAgentState,
} from "@/lib/agents/store";
import { readAgentTelemetrySnapshot } from "@/lib/agents/sources";
import type { AgentBrief, AgentRunnerResult } from "@/lib/agents/types";
import { nowIso } from "@/lib/agents/time";

function summarizeOps(snapshot: AgentStateSnapshot, actionCount: number, telemetry: Awaited<ReturnType<typeof readAgentTelemetrySnapshot>>): string {
  if (snapshot.source === "invalid") {
    return "State storage looked malformed. Logged a low-severity ops incident for follow-up.";
  }

  if (!telemetry.readinessReady) {
    return `Ops detected issues: ${telemetry.readinessReasons.join("; ")}.`;
  }

  return `Scoring healthy; ${telemetry.signalsScoredCount} scored / ${telemetry.signalsPendingCount} pending in recent window across ${actionCount} recent control-plane actions.`;
}

export async function runOpsAgent(): Promise<AgentRunnerResult> {
  const now = nowIso();
  const snapshot = await readAgentStateSnapshot();
  const telemetry = await readAgentTelemetrySnapshot();
  const actions = await listAgentActions(50);
  let createdIncidentId: string | null = null;

  if (snapshot.source === "invalid") {
    const { incident } = await upsertIncident({
      severity: "LOW",
      source: "ops",
      category: "UNKNOWN",
      title: "Control-plane state malformed",
      summary: "The stored agent state was malformed and was replaced with safe defaults.",
      notes: ["Day-1 ops runner detected invalid control-plane state."],
    });
    createdIncidentId = incident.id;
  }

  if (telemetry.staleScoring) {
    const result = await upsertIncident({
      severity: telemetry.marketOpen ? "HIGH" : "MEDIUM",
      source: "ops",
      category: "SCORING",
      title: "Scoring stale while pending backlog exists",
      summary: `Pending=${telemetry.signalsPendingCount}, scored=${telemetry.signalsScoredCount}. No recent scoring activity in market-open conditions.`,
      notes: telemetry.readinessReasons,
    });
    if (result.created && !createdIncidentId) createdIncidentId = result.incident.id;
  } else {
    await resolveIncident(
      { category: "SCORING", title: "Scoring stale while pending backlog exists" },
      "Scoring returned to healthy cadence."
    );
  }

  if (telemetry.staleScanner) {
    const result = await upsertIncident({
      severity: telemetry.marketOpen ? "MEDIUM" : "LOW",
      source: "ops",
      category: "SCANNER",
      title: "Scanner stale during market window",
      summary: "Scanner heartbeat appears stale while market is open.",
      notes: telemetry.readinessReasons,
    });
    if (result.created && !createdIncidentId) createdIncidentId = result.incident.id;
  } else {
    await resolveIncident(
      { category: "SCANNER", title: "Scanner stale during market window" },
      "Scanner freshness recovered."
    );
  }

  if (telemetry.autoEntryDisabled) {
    const result = await upsertIncident({
      severity: "MEDIUM",
      source: "ops",
      category: "AUTO_ENTRY",
      title: "Auto-entry disabled",
      summary: telemetry.autoEntryDisableReason || "Auto-entry is currently disabled.",
      notes: telemetry.readinessReasons,
    });
    if (result.created && !createdIncidentId) createdIncidentId = result.incident.id;
  } else {
    await resolveIncident({ category: "AUTO_ENTRY", title: "Auto-entry disabled" }, "Auto-entry enabled again.");
  }

  if (telemetry.openTradeMismatch) {
    const result = await upsertIncident({
      severity: "MEDIUM",
      source: "ops",
      category: "BROKER_SYNC",
      title: "Open trade mismatch",
      summary: `Broker positions=${telemetry.brokerPositionsCount}, DB operational open=${telemetry.dbOperationalOpenCount}.`,
      notes: telemetry.readinessReasons,
    });
    if (result.created && !createdIncidentId) createdIncidentId = result.incident.id;
  } else {
    await resolveIncident({ category: "BROKER_SYNC", title: "Open trade mismatch" }, "Broker/DB counts aligned.");
  }

  const openIncidents = await listOpenIncidents(50);
  const activeIncidentCount = openIncidents.length;
  const brief: AgentBrief = {
    id: crypto.randomUUID(),
    agent: "ops",
    briefType: "STATUS",
    createdAt: now,
    title: activeIncidentCount === 0 ? "Ops healthy" : `Ops tracking ${activeIncidentCount} incident${activeIncidentCount === 1 ? "" : "s"}`,
    summary: summarizeOps(snapshot, actions.length, telemetry),
    details: {
      stateSource: snapshot.source,
      activeIncidentCount,
      recentActionCount: actions.length,
      telemetry,
    },
  };

  await appendAgentBrief(brief);

  const savedState = await writeAgentState({
    ...snapshot.state,
    asOf: now,
    activeIncidentCount,
    telemetry: {
      readinessReady: telemetry.readinessReady,
      readinessReasons: telemetry.readinessReasons,
      recentSignalsPending: telemetry.signalsPendingCount,
      recentSignalsScored: telemetry.signalsScoredCount,
      recentZeroScores: telemetry.zeroScoreCount,
      scannerStale: telemetry.staleScanner,
      scoringStale: telemetry.staleScoring,
      autoEntryDisabled: telemetry.autoEntryDisabled,
      openTradeMismatch: telemetry.openTradeMismatch,
    },
    latestBriefId: brief.id,
    updatedBy: "ops",
  });

  const action = await appendAgentAction({
    id: crypto.randomUUID(),
    createdAt: now,
    agent: "ops",
    actionType: "HEALTH_SUMMARY",
    status: "APPLIED",
    summary: telemetry.readinessReady
      ? `Ops healthy: scored=${telemetry.signalsScoredCount}, pending=${telemetry.signalsPendingCount}.`
      : `Ops flagged issues: ${telemetry.readinessReasons.join("; ")}`,
    metadata: {
      stateSource: snapshot.source,
      createdIncidentId,
      telemetry,
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