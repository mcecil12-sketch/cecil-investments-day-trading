import type { AgentAction, AgentIncident } from "@/lib/agents/types";
import type { AgentTelemetrySnapshot } from "@/lib/agents/sources";
import { getRemediationType } from "@/lib/agents/incidents";
import { reconcileOpenTrades } from "@/lib/maintenance/reconcileOpenTrades";
import { clearBrokerTruthCache } from "@/lib/broker/truth";

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export type RemediationResult = {
  attempted: boolean;
  success: boolean;
  summary: string;
  detail?: Record<string, unknown>;
  error?: string;
};

// ---------------------------------------------------------------------------
// Cooldown guard — 30 minutes between remediation attempts per incident
// ---------------------------------------------------------------------------

const REMEDIATION_COOLDOWN_MS = 30 * 60 * 1000;

export function isRemediationOnCooldown(
  incidentId: string,
  recentActions: AgentAction[],
): boolean {
  const cutoff = Date.now() - REMEDIATION_COOLDOWN_MS;
  return recentActions.some((action) => {
    if (action.actionType !== "REMEDIATION_ATTEMPTED") return false;
    const meta = action.metadata as Record<string, unknown> | undefined;
    if (meta?.incidentId !== incidentId) return false;
    const ts = Date.parse(action.createdAt);
    return Number.isFinite(ts) && ts >= cutoff;
  });
}

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

export async function executeRemediationForIncident(
  incident: AgentIncident,
  _telemetry: AgentTelemetrySnapshot,
): Promise<RemediationResult> {
  const remediationType = getRemediationType(incident);

  if (remediationType === "BROKER_SYNC") {
    return attemptBrokerSyncRemediation(incident);
  }

  // All other types: observe only — no automated mutation
  return {
    attempted: false,
    success: false,
    summary: `Remediation for ${incident.category} is observe-only. Engineering task created; no automated action taken.`,
  };
}

// ---------------------------------------------------------------------------
// BROKER_SYNC remediation: reconcile open trades via shared library
// ---------------------------------------------------------------------------

async function attemptBrokerSyncRemediation(
  incident: AgentIncident,
): Promise<RemediationResult> {
  try {
    const result = await reconcileOpenTrades({
      dryRun: false,
      max: 100,
      closeReason: "agent_ops_reconcile",
      syncToPositionOpen: true,
      runSource: "ops-agent",
      runId: incident.id,
      deadlineMs: 25_000,
    });

    // Clear broker truth cache so next telemetry read is fresh
    clearBrokerTruthCache();

    if (!result.ok) {
      return {
        attempted: true,
        success: false,
        summary: `Broker sync reconcile attempted but failed: ${result.error ?? "unknown error"}.`,
        detail: {
          error: result.error,
          checked: result.checked,
          closed: result.closed ?? 0,
          synced: result.synced ?? 0,
        },
        error: result.error ?? "broker_truth_failed",
      };
    }

    const changed = (result.closed ?? 0) + (result.synced ?? 0);
    return {
      attempted: true,
      success: true,
      summary: `Broker sync reconcile completed: ${result.closed ?? 0} closed, ${result.synced ?? 0} synced, ${result.checked} checked.`,
      detail: {
        closed: result.closed ?? 0,
        synced: result.synced ?? 0,
        checked: result.checked,
        backfilled: result.backfilled ?? 0,
        changed,
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    clearBrokerTruthCache();
    return {
      attempted: true,
      success: false,
      summary: `Broker sync remediation threw: ${message}.`,
      error: message,
    };
  }
}
