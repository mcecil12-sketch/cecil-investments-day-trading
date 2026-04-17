import {
  type AgentStateSnapshot,
  appendAgentAction,
  appendAgentBrief,
  listAgentActions,
  listOpenIncidents,
  readAgentStateSnapshot,
  resolveIncident,
  updateIncidentById,
  upsertIncident,
  writeAgentState,
} from "@/lib/agents/store";
import { readAgentTelemetrySnapshot } from "@/lib/agents/sources";
import {
  executeRemediationForIncident,
  isRemediationOnCooldown,
} from "@/lib/agents/remediation";
import { mapIncidentsToTasks } from "@/lib/agents/critical-incident-mapper";
import { auditProtectionIntegrity } from "@/lib/risk/protection-integrity";
import { fetchBrokerTruth } from "@/lib/broker/truth";
import { readTrades } from "@/lib/tradesStore";
import { isOpenTradeStatus } from "@/lib/trades/protection";
import type { AgentBrief, AgentIncident, AgentIncidentCategory, AgentRunnerResult } from "@/lib/agents/types";
import { nowIso } from "@/lib/agents/time";

function summarizeOps(
  snapshot: AgentStateSnapshot,
  actionCount: number,
  telemetry: Awaited<ReturnType<typeof readAgentTelemetrySnapshot>>,
): string {
  if (snapshot.source === "invalid") {
    return "State storage looked malformed. Logged a low-severity ops incident for follow-up.";
  }
  if (telemetry.openTradeMismatch) {
    return `Ops detected operational mismatch: broker positions=${telemetry.brokerPositionsCount}, actual operational DB open=${telemetry.dbActualOperationalCount}.`;
  }
  if (!telemetry.readinessReady) {
    return `Ops detected issues: ${telemetry.readinessReasons.join("; ")}.`;
  }
  return `Ops is healthy. No true broker/db operational mismatch detected. Scoring healthy; ${telemetry.signalsScoredCount} scored / ${telemetry.signalsPendingCount} pending in recent window across ${actionCount} recent control-plane actions.`;
}

export async function runOpsAgent(): Promise<AgentRunnerResult> {
  const now = nowIso();
  const snapshot = await readAgentStateSnapshot();
  const telemetry = await readAgentTelemetrySnapshot();
  const actions = await listAgentActions(50);
  let createdIncidentId: string | null = null;

  // ------- Incident upsert / resolve cycle -------

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
      "Scoring returned to healthy cadence.",
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
      "Scanner freshness recovered.",
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
    await resolveIncident(
      { category: "AUTO_ENTRY", title: "Auto-entry disabled" },
      "Auto-entry enabled again.",
    );
  }

  let brokerSyncIncidentId: string | null = null;
  if (telemetry.openTradeMismatch) {
    const result = await upsertIncident({
      severity: "MEDIUM",
      source: "ops",
      category: "BROKER_SYNC",
      title: "Open trade mismatch",
      summary: `Broker positions=${telemetry.brokerPositionsCount}, DB actual operational open=${telemetry.dbActualOperationalCount}. ${telemetry.mismatchNote ?? ""}`.trim(),
      notes: telemetry.readinessReasons,
    });
    brokerSyncIncidentId = result.incident.id;
    if (result.created && !createdIncidentId) createdIncidentId = result.incident.id;
  } else {
    await resolveIncident(
      { category: "BROKER_SYNC", title: "Open trade mismatch" },
      "No true operational mismatch. Broker/DB counts aligned on operational truth.",
    );
  }

  // ------- Bounded remediation: BROKER_SYNC only -------

  let remediationSummary: string | undefined;
  let lastRemediationAt: string | null = null;

  if (brokerSyncIncidentId !== null && telemetry.openTradeMismatch) {
    const openIncidentsSnapshot = await listOpenIncidents(50);
    const brokerIncident: AgentIncident | null =
      openIncidentsSnapshot.find((inc) => inc.id === brokerSyncIncidentId) ?? null;

    const canAttempt =
      brokerIncident !== null &&
      (brokerIncident.status === "OPEN" || brokerIncident.status === "MONITORING") &&
      !isRemediationOnCooldown(brokerSyncIncidentId, actions);

    if (canAttempt && brokerIncident !== null) {
      await appendAgentAction({
        id: crypto.randomUUID(),
        createdAt: now,
        agent: "ops",
        actionType: "REMEDIATION_ATTEMPTED",
        status: "APPLIED",
        summary: `Attempting broker sync reconcile for incident ${brokerSyncIncidentId}. Before: broker=${telemetry.brokerPositionsCount} db=${telemetry.dbActualOperationalCount}.`,
        metadata: {
          incidentId: brokerSyncIncidentId,
          category: "BROKER_SYNC",
          beforeBrokerPositionsCount: telemetry.brokerPositionsCount,
          beforeDbOperationalOpenCount: telemetry.dbActualOperationalCount,
        },
      });

      const remediation = await executeRemediationForIncident(brokerIncident, telemetry);
      lastRemediationAt = now;

      if (remediation.attempted) {
        // Re-read telemetry immediately after reconcile to verify if mismatch cleared
        const afterTelemetry = await readAgentTelemetrySnapshot();
        const mismatchCleared = !afterTelemetry.openTradeMismatch;

        const beforeAfterSuffix = ` Before: broker=${telemetry.brokerPositionsCount} db=${telemetry.dbActualOperationalCount}. After: broker=${afterTelemetry.brokerPositionsCount} db=${afterTelemetry.dbActualOperationalCount}.`;
        remediationSummary =
          remediation.summary + beforeAfterSuffix + (mismatchCleared ? " RESOLVED." : "");

        if (remediation.success || mismatchCleared) {
          await appendAgentAction({
            id: crypto.randomUUID(),
            createdAt: now,
            agent: "ops",
            actionType: "REMEDIATION_SUCCEEDED",
            status: "APPLIED",
            summary: remediationSummary,
            metadata: {
              incidentId: brokerSyncIncidentId,
              mismatchCleared,
              afterBrokerPositionsCount: afterTelemetry.brokerPositionsCount,
              afterDbOperationalOpenCount: afterTelemetry.dbActualOperationalCount,
              ...remediation.detail,
            },
          });

          if (mismatchCleared) {
            await resolveIncident(
              { category: "BROKER_SYNC", title: "Open trade mismatch" },
              `Ops reconcile cleared mismatch. broker=${afterTelemetry.brokerPositionsCount} db=${afterTelemetry.dbActualOperationalCount}.`,
            );
            await appendAgentAction({
              id: crypto.randomUUID(),
              createdAt: now,
              agent: "ops",
              actionType: "INCIDENT_RESOLVED",
              status: "APPLIED",
              summary: `Incident ${brokerSyncIncidentId} resolved: broker/DB counts now aligned.`,
              metadata: { incidentId: brokerSyncIncidentId },
            });
            brokerSyncIncidentId = null;
          } else {
            await updateIncidentById(
              brokerSyncIncidentId,
              {
                status: "MONITORING",
                summary: `Broker positions=${afterTelemetry.brokerPositionsCount}, DB actual operational open=${afterTelemetry.dbActualOperationalCount}. Reconcile ran; mismatch persists.`,
              },
              `Ops reconcile ran but mismatch persists: broker=${afterTelemetry.brokerPositionsCount} db=${afterTelemetry.dbActualOperationalCount}.`,
            );
            await appendAgentAction({
              id: crypto.randomUUID(),
              createdAt: now,
              agent: "ops",
              actionType: "INCIDENT_MONITORING",
              status: "APPLIED",
              summary: `Incident ${brokerSyncIncidentId} MONITORING: reconcile ran but mismatch persists.`,
              metadata: { incidentId: brokerSyncIncidentId },
            });
          }
        } else {
          remediationSummary = remediation.summary + beforeAfterSuffix;
          await appendAgentAction({
            id: crypto.randomUUID(),
            createdAt: now,
            agent: "ops",
            actionType: "REMEDIATION_FAILED",
            status: "FAILED",
            summary: remediationSummary,
            metadata: {
              incidentId: brokerSyncIncidentId,
              error: remediation.error,
              ...remediation.detail,
            },
          });
        }
      } else {
        remediationSummary = remediation.summary;
      }
    } else if (brokerIncident !== null) {
      remediationSummary = `Broker sync remediation on cooldown for incident ${brokerSyncIncidentId}. broker=${telemetry.brokerPositionsCount} db=${telemetry.dbActualOperationalCount}.`;
    }
  }

  // ------- PROACTIVE PROTECTION INCIDENT ESCALATION -------
  // Check for CRITICAL protection incidents (MISSING_STOP, etc.) and
  // escalate them to the critical task queue so execute loop can act.
  let protectionEscalationSummary: string | null = null;
  let escalatedCriticalCount = 0;
  try {
    const brokerTruth = await fetchBrokerTruth();
    if (!brokerTruth.error) {
      const allTrades = await readTrades<any>().catch(() => []);
      const openTrades = (Array.isArray(allTrades) ? allTrades : [])
        .filter((t) => isOpenTradeStatus(t?.status))
        .map((t: any) => ({
          id: String(t.id || ""),
          ticker: String(t.ticker || ""),
          side: String(t.side || ""),
          status: String(t.status || ""),
          qty: Number(t.size || t.qty || 0),
          stopOrderId: t.stopOrderId || t.alpacaStopOrderId,
          protectionStatus: t.protectionStatus,
        }));

      const protectionAudit = auditProtectionIntegrity({
        openTrades,
        brokerPositions: brokerTruth.positions || [],
        brokerOrders: brokerTruth.openOrders || [],
      });

      if (!protectionAudit.ok && protectionAudit.criticalCount > 0) {
        // Escalate CRITICAL incidents to critical task queue
        const criticalIncidents = protectionAudit.incidents.filter(
          (i) => i.severity === "CRITICAL"
        );
        const escalatedTasks = await mapIncidentsToTasks(criticalIncidents);
        escalatedCriticalCount = escalatedTasks.length;

        if (escalatedCriticalCount > 0) {
          protectionEscalationSummary = `Escalated ${escalatedCriticalCount} CRITICAL protection incident(s) to execution queue: ${criticalIncidents.map((i) => `${i.symbol}:${i.code}`).join(", ")}`;
          console.log(`[OPS-AGENT] ${protectionEscalationSummary}`);

          // Log action for escalation
          await appendAgentAction({
            id: crypto.randomUUID(),
            createdAt: now,
            agent: "ops",
            actionType: "INCIDENT_ESCALATED",
            status: "APPLIED",
            summary: protectionEscalationSummary,
            metadata: {
              escalatedCount: escalatedCriticalCount,
              incidents: criticalIncidents.map((i) => ({
                code: i.code,
                symbol: i.symbol,
                severity: i.severity,
              })),
            },
          });
        }

        // Also upsert agent incident for visibility
        const result = await upsertIncident({
          severity: "HIGH",
          source: "ops",
          category: "TRADES",
          title: "Protection integrity critical",
          summary: `${protectionAudit.criticalCount} trade(s) with CRITICAL protection issues: ${criticalIncidents.map((i) => `${i.symbol}:${i.code}`).slice(0, 5).join(", ")}`,
          notes: [`Escalated to critical queue: ${escalatedCriticalCount}`, ...telemetry.readinessReasons],
        });
        if (result.created && !createdIncidentId) createdIncidentId = result.incident.id;
      } else if (protectionAudit.ok) {
        // Resolve any prior protection incidents
        await resolveIncident(
          { category: "TRADES", title: "Protection integrity critical" },
          "All open trades have valid stop protection.",
        );
      }
    }
  } catch (err) {
    console.warn("[OPS-AGENT] Protection escalation check failed (non-fatal):", err);
  }

  // ------- Compile open incident categories for state -------

  const openIncidents = await listOpenIncidents(50);
  const activeIncidentCount = openIncidents.length;
  const openIncidentCategories = Array.from(
    new Set(openIncidents.map((inc) => inc.category)),
  ) as AgentIncidentCategory[];

  // ------- Brief -------

  const brief: AgentBrief = {
    id: crypto.randomUUID(),
    agent: "ops",
    briefType: "STATUS",
    createdAt: now,
    title:
      activeIncidentCount === 0
        ? "Ops healthy"
        : `Ops tracking ${activeIncidentCount} incident${activeIncidentCount === 1 ? "" : "s"}`,
    summary: summarizeOps(snapshot, actions.length, telemetry),
    details: {
      stateSource: snapshot.source,
      activeIncidentCount,
      recentActionCount: actions.length,
      remediationSummary: remediationSummary ?? null,
      protectionEscalation: {
        ran: true,
        escalatedCriticalCount,
        summary: protectionEscalationSummary,
      },
      telemetry,
    },
  };

  await appendAgentBrief(brief);

  const savedState = await writeAgentState({
    ...snapshot.state,
    asOf: now,
    activeIncidentCount,
    openIncidentCategories,
    remediationSummary,
    lastRemediationAt,
    telemetry: {
      readinessReady: telemetry.readinessReady,
      readinessReasons: telemetry.readinessReasons,
      brokerPositionsCount: telemetry.brokerPositionsCount,
      dbOpenTradesCount: telemetry.dbOpenTradesCount,
      dbAutoOpenTradesCount: telemetry.dbAutoOpenTradesCount,
      dbActualOperationalCount: telemetry.dbActualOperationalCount,
      dbOperationalOpenCount: telemetry.dbOperationalOpenCount,
      mismatchNote: telemetry.mismatchNote,
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
      remediationSummary: remediationSummary ?? null,
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