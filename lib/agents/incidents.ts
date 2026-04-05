import type { AgentIncident, AgentIncidentCategory } from "@/lib/agents/types";

// ---------------------------------------------------------------------------
// Remediation type enum
// ---------------------------------------------------------------------------

export type RemediationType =
  | "BROKER_SYNC"       // Can invoke reconcileOpenTrades safely
  | "OBSERVE_ONLY"      // Flag and escalate; no automated action
  | "CONSERVATIVE_LOG"  // Log incident + create engineering task; no automatic repair
  | "NONE";

// ---------------------------------------------------------------------------
// Classification result
// ---------------------------------------------------------------------------

export type IncidentClassification = {
  fingerprint: string;
  remediationType: RemediationType;
  likelyRootCause: string;
  recommendedNextAction: string;
  likelyFiles: string[];
  likelyRoutes: string[];
};

// ---------------------------------------------------------------------------
// Fingerprint helpers
// ---------------------------------------------------------------------------

export function normalizeIncidentFingerprint(
  category: AgentIncidentCategory,
  title: string,
): string {
  return `${category}::${title.trim().toUpperCase().replace(/\s+/g, " ")}`;
}

// ---------------------------------------------------------------------------
// Remediation type lookup
// ---------------------------------------------------------------------------

export function getRemediationType(incident: AgentIncident): RemediationType {
  switch (incident.category) {
    case "BROKER_SYNC":
      return "BROKER_SYNC";
    case "AUTO_ENTRY":
      return "OBSERVE_ONLY";
    case "SCORING":
    case "SCANNER":
      return "CONSERVATIVE_LOG";
    default:
      return "NONE";
  }
}

// ---------------------------------------------------------------------------
// Likely files per category
// ---------------------------------------------------------------------------

export function likelyFilesForCategory(category: AgentIncidentCategory): string[] {
  switch (category) {
    case "BROKER_SYNC":
      return [
        "app/api/maintenance/reconcile-open-trades/route.ts",
        "app/api/maintenance/sync-broker-state/route.ts",
        "lib/maintenance/reconcileOpenTrades.ts",
        "lib/broker/truth.ts",
        "lib/trades/operational.ts",
        "app/api/ops/status/route.ts",
      ];
    case "SCORING":
      return [
        "app/api/ai/score/drain/route.ts",
        "lib/aiScoring.ts",
        "lib/ai/scoreDrainApply.ts",
        "lib/agents/sources.ts",
      ];
    case "SCANNER":
      return [
        "app/api/readiness/route.ts",
        "app/api/ops/status/route.ts",
        "lib/funnelRedis.ts",
        "lib/agents/sources.ts",
      ];
    case "AUTO_ENTRY":
      return [
        "app/api/auto-entry/execute/route.ts",
        "lib/autoEntry/engine.ts",
        "lib/autoEntry/guardrails.ts",
        "lib/autoEntry/guardrailsStore.ts",
      ];
    case "TRADES":
      return [
        "app/api/trades/approve/route.ts",
        "lib/tradesStore.ts",
        "lib/trades/canonical.ts",
        "lib/trades/operational.ts",
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
    default:
      return [
        "app/api/ops/status/route.ts",
        "lib/agents/store.ts",
        "app/api/agents/run/route.ts",
      ];
  }
}

// ---------------------------------------------------------------------------
// Likely routes per category
// ---------------------------------------------------------------------------

function likelyRoutesForCategory(category: AgentIncidentCategory): string[] {
  switch (category) {
    case "BROKER_SYNC":
      return [
        "/api/maintenance/reconcile-open-trades",
        "/api/maintenance/sync-broker-state",
        "/api/ops/status",
        "/api/agents/run",
        "/api/readiness",
      ];
    case "SCORING":
      return ["/api/ai/score/drain", "/api/agents/run", "/api/readiness"];
    case "SCANNER":
      return ["/api/readiness", "/api/ops/status", "/api/agents/run"];
    case "AUTO_ENTRY":
      return ["/api/auto-entry/execute", "/api/ops/status", "/api/agents/run"];
    default:
      return ["/api/ops/status", "/api/agents/run"];
  }
}

// ---------------------------------------------------------------------------
// Root cause inference
// ---------------------------------------------------------------------------

function inferLikelyRootCause(incident: AgentIncident): string {
  if (incident.category === "BROKER_SYNC") {
    return (
      `DB has open trades that Alpaca does not hold as positions. ` +
      `Likely cause: a fill, close, or cancellation event was not applied back to the DB. ` +
      `The reconcile maintenance route should identify and close or sync the stale records. ` +
      `Details: ${incident.summary}`
    );
  }
  if (incident.category === "SCORING") {
    return (
      `Scoring pipeline has not processed pending signals within the expected window. ` +
      `Likely cause: drain route not invoked, scoring loop stalled, or AI quota exhausted. ` +
      `Details: ${incident.summary}`
    );
  }
  if (incident.category === "SCANNER") {
    return (
      `Scanner heartbeat is stale. ` +
      `Likely cause: scan cron not firing, funnel Redis data not written, or scanner timeout. ` +
      `Details: ${incident.summary}`
    );
  }
  if (incident.category === "AUTO_ENTRY") {
    return (
      `Auto-entry is disabled or blocked. ` +
      `Likely cause: guardrail triggered, manual toggle, daily loss limit reached, or system config mismatch. ` +
      `Details: ${incident.summary}`
    );
  }
  return `${incident.category} incident: ${incident.summary}`;
}

// ---------------------------------------------------------------------------
// Recommended next action
// ---------------------------------------------------------------------------

function inferRecommendedNextAction(incident: AgentIncident): string {
  switch (incident.category) {
    case "BROKER_SYNC":
      return (
        `Run /api/maintenance/reconcile-open-trades to close stale DB records. ` +
        `Re-check /api/ops/status and /api/readiness after. ` +
        `Verify broker truth positionsCount aligns with DB operational open count.`
      );
    case "SCORING":
      return (
        `Check scoring drain route and AI budget. ` +
        `Trigger manual scoring run if safe. ` +
        `Verify signal pipeline integrity via /api/readiness.`
      );
    case "SCANNER":
      return (
        `Check scanner cron schedule and funnel Redis state. ` +
        `Verify scan -> signals pipeline is healthy via /api/ops/status.`
      );
    case "AUTO_ENTRY":
      return (
        `Review guardrail config and daily loss state. ` +
        `If safe conditions are met, reset auto-entry via admin settings. ` +
        `Do not auto-reset without verifying root cause.`
      );
    default:
      return `Review /api/ops/status diagnostics and agent logs. Escalate if persistent.`;
  }
}

// ---------------------------------------------------------------------------
// Full classification
// ---------------------------------------------------------------------------

export function classifyIncident(incident: AgentIncident): IncidentClassification {
  return {
    fingerprint: normalizeIncidentFingerprint(incident.category, incident.title),
    remediationType: getRemediationType(incident),
    likelyRootCause: inferLikelyRootCause(incident),
    recommendedNextAction: inferRecommendedNextAction(incident),
    likelyFiles: likelyFilesForCategory(incident.category),
    likelyRoutes: likelyRoutesForCategory(incident.category),
  };
}

// ---------------------------------------------------------------------------
// Severity comparison (descending: highest first)
// ---------------------------------------------------------------------------

export function compareIncidentSeverity(a: AgentIncident, b: AgentIncident): number {
  const rank: Record<string, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 };
  return (rank[b.severity] ?? 0) - (rank[a.severity] ?? 0);
}
