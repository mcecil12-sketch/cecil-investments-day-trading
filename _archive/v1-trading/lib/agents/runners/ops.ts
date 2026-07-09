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
import { readTodayFunnel } from "@/lib/funnelRedis";
import { readLatestSeedRunTelemetry } from "@/lib/autoEntry/seedTelemetry";
import { readSignals } from "@/lib/jsonDb";
import { getSignalTimestampMs } from "@/lib/signals/since";
import { createManualActionTask, listManualActionTasks } from "@/lib/agents/manual-action-queue";
import type { AgentBrief, AgentIncident, AgentIncidentCategory, AgentRunnerResult } from "@/lib/agents/types";
import { getEtDateString, nowIso } from "@/lib/agents/time";
import { promises as fs } from "fs";
import path from "path";

type WorkflowChecks = {
  minScoreThresholds: string[];
  missingSteps: string[];
  authHeaderIssues: string[];
  proposedFixes: string[];
  inspectionAvailable: boolean;
};

type FunnelMismatchDiagnostics = {
  qualified: number;
  seeded: number;
  executed: number;
  freshQualifiedSignals: number;
  staleQualifiedSignals: number;
  totalQualifiedSignals: number;
  staleThresholdUsedMs: number;
  eligibleCount: number;
  lastSeedAt: string | null;
  lastExecuteAt: string | null;
  lastSeedSource: string | null;
  lastSeedRunId: string | null;
  latestSeedCreatedCount: number;
  seedSkipReasonBreakdown: Record<string, number>;
  executeSkipReasonBreakdown: Record<string, number>;
  executeNoAutoPendingCount: number;
  offendingSignals: Array<{
    signalId: string;
    symbol: string;
    createdAt: string | null;
    seedEvaluatedAt: string | null;
    ageMs: number | null;
  }>;
  workflowChecks: WorkflowChecks;
};

function upper(value: unknown): string {
  return String(value || "").trim().toUpperCase();
}

function isFinitePositiveNumber(value: unknown): boolean {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

function detectSeedMinScoreThreshold(workflowPath: string, content: string): string[] {
  const matches: string[] = [];
  const endpointThreshold = /seed-from-signals[^\n]*minScore\s*=\s*7\.5/gi;
  const bodyThreshold = /"minScore"\s*:\s*7\.5/gi;
  if (endpointThreshold.test(content) || bodyThreshold.test(content)) {
    matches.push(`${workflowPath}: seed-from-signals call hardcodes minScore=7.5`);
  }
  return matches;
}

function inspectWorkflowAuth(workflowPath: string, content: string): string[] {
  const issues: string[] = [];
  if (content.includes("/api/auto-entry/seed-from-signals") && !content.includes("x-cron-token: $CRON_TOKEN")) {
    issues.push(`${workflowPath}: seed-from-signals call missing x-cron-token auth header`);
  }
  if (content.includes("/api/auto-entry/execute") && !content.includes("x-auto-entry-token: $AUTO_ENTRY_TOKEN")) {
    issues.push(`${workflowPath}: auto-entry execute call missing x-auto-entry-token auth header`);
  }
  return issues;
}

function inspectMarketLoopOrder(workflowPath: string, content: string): string[] {
  const issues: string[] = [];
  const drainIdx = content.indexOf("/api/ai/score/drain");
  const seedIdx = content.indexOf("/api/auto-entry/seed-from-signals");
  const executeIdx = content.indexOf("/api/auto-entry/execute");

  if (drainIdx < 0) issues.push(`${workflowPath}: missing /api/ai/score/drain step`);
  if (seedIdx < 0) issues.push(`${workflowPath}: missing /api/auto-entry/seed-from-signals step`);
  if (executeIdx < 0) issues.push(`${workflowPath}: missing /api/auto-entry/execute step`);
  if (drainIdx >= 0 && seedIdx >= 0 && executeIdx >= 0 && !(drainIdx < seedIdx && seedIdx < executeIdx)) {
    issues.push(`${workflowPath}: expected order is score/drain -> seed-from-signals -> execute`);
  }

  return issues;
}

async function checkWorkflowFunnelCadence(): Promise<WorkflowChecks> {
  const files = [
    ".github/workflows/market-loop.yml",
    ".github/workflows/intraday-score-worker.yml",
    ".github/workflows/auto-entry-execute.yml",
    ".github/workflows/auto-entry-seed-cadence.yml",
  ];

  const minScoreThresholds: string[] = [];
  const missingSteps: string[] = [];
  const authHeaderIssues: string[] = [];
  let inspectionAvailable = true;

  for (const relativePath of files) {
    const absolutePath = path.join(process.cwd(), relativePath);
    const content = await fs.readFile(absolutePath, "utf8").catch(() => "");
    if (!content) {
      inspectionAvailable = false;
      missingSteps.push(`${relativePath}: workflow file unavailable for inspection at runtime`);
      continue;
    }

    minScoreThresholds.push(...detectSeedMinScoreThreshold(relativePath, content));
    authHeaderIssues.push(...inspectWorkflowAuth(relativePath, content));

    if (relativePath.endsWith("market-loop.yml")) {
      missingSteps.push(...inspectMarketLoopOrder(relativePath, content));
    }
  }

  const proposedFixes: string[] = [];
  if (minScoreThresholds.length > 0) {
    proposedFixes.push("Remove minScore=7.5 from scheduled seed-from-signals calls and rely on qualified+tier+overlay gating.");
  }
  if (missingSteps.length > 0) {
    proposedFixes.push("Ensure market-loop calls score drain, then seed-from-signals, then execute during market hours.");
  }
  if (authHeaderIssues.length > 0) {
    proposedFixes.push("Use x-cron-token for seed-from-signals and x-auto-entry-token for execute in every workflow call.");
  }
  if (proposedFixes.length === 0) {
    proposedFixes.push("No workflow threshold/order/auth mismatch detected; inspect runtime skip reason breakdowns for guardrail or capacity blocks.");
  }

  return {
    minScoreThresholds,
    missingSteps,
    authHeaderIssues,
    proposedFixes,
    inspectionAvailable,
  };
}

async function computeFunnelMismatchDiagnostics(now: string): Promise<FunnelMismatchDiagnostics> {
  const etDate = getEtDateString(new Date(now));
  const [funnel, trades, seedRun, workflowChecks, allSignals] = await Promise.all([
    readTodayFunnel().catch(() => null),
    readTrades<any>().catch(() => []),
    readLatestSeedRunTelemetry(etDate).catch(() => null),
    checkWorkflowFunnelCadence(),
    readSignals().catch(() => []),
  ]);

  const qualified = Number(funnel?.qualified ?? 0);
  const seeded = Number(funnel?.seedCreatedCount ?? 0);
  const executeFromSeededLong = Number(funnel?.executeFromSeededLong ?? 0);
  const executeFromSeededShort = Number(funnel?.executeFromSeededShort ?? 0);
  const executed = executeFromSeededLong + executeFromSeededShort;

  const todayTrades = (Array.isArray(trades) ? trades : []).filter((t: any) => String(t?.etDate || "") === etDate);
  const autoTrades = todayTrades.filter((t: any) => {
    const src = upper(t?.source);
    return src === "AUTO" || src === "AUTO-ENTRY";
  });

  const eligibleCount = autoTrades.filter((t: any) => {
    if (upper(t?.status) !== "AUTO_PENDING") return false;
    const side = upper(t?.side);
    if (side !== "LONG" && side !== "SHORT") return false;
    if (!isFinitePositiveNumber(t?.entryPrice) || !isFinitePositiveNumber(t?.stopPrice)) return false;
    const target = t?.takeProfitPrice ?? t?.targetPrice;
    if (!isFinitePositiveNumber(target)) return false;
    return true;
  }).length;

  const executeSkipReasonBreakdown: Record<string, number> = {};
  let latestExecuteTs = Number.NEGATIVE_INFINITY;
  for (const t of autoTrades) {
    const outcome = String(t?.executeOutcome || "").trim();
    if (outcome && outcome !== "EXECUTED" && outcome !== "PENDING") {
      executeSkipReasonBreakdown[outcome] = (executeSkipReasonBreakdown[outcome] ?? 0) + 1;
    }

    const executeTs = Date.parse(String(t?.executeAttemptedAt || t?.openedAt || t?.updatedAt || ""));
    if (Number.isFinite(executeTs) && executeTs > latestExecuteTs) latestExecuteTs = executeTs;
  }

  const executeNoAutoPendingCount =
    (executeSkipReasonBreakdown["SKIPPED_NO_AUTO_PENDING"] ?? 0) +
    (executeSkipReasonBreakdown["SKIPPED_NO_LONGER_ELIGIBLE"] ?? 0);

  const staleThresholdUsedMs = Number(seedRun?.staleThresholdUsedMs ?? 30 * 60 * 1000);
  const nowMs = Date.now();
  const seedEvalSlaMs = 10 * 60 * 1000;

  const todayQualifiedSignals = (Array.isArray(allSignals) ? allSignals : []).filter((signal: any) => {
    if (signal?.qualified !== true) return false;
    const tsMs = getSignalTimestampMs(signal, "createdAt");
    if (!Number.isFinite(tsMs)) return false;
    const signalDate = getEtDateString(new Date(tsMs as number));
    return signalDate === etDate;
  });

  let freshQualifiedSignals = 0;
  let staleQualifiedSignals = 0;
  const offendingSignals: FunnelMismatchDiagnostics["offendingSignals"] = [];
  for (const signal of todayQualifiedSignals) {
    const createdAt = typeof signal?.createdAt === "string" ? signal.createdAt : null;
    const createdMs = getSignalTimestampMs(signal, "createdAt");
    const seedEvaluatedAt = typeof signal?.seedEvaluatedAt === "string" ? signal.seedEvaluatedAt : null;
    const seedEvaluatedMs = seedEvaluatedAt ? Date.parse(seedEvaluatedAt) : Number.NaN;
    const ageMs = Number.isFinite(createdMs) ? Math.max(0, nowMs - (createdMs as number)) : null;

    if (typeof ageMs === "number" && ageMs <= staleThresholdUsedMs) freshQualifiedSignals += 1;
    else staleQualifiedSignals += 1;

    if (Number.isFinite(createdMs) && !Number.isFinite(seedEvaluatedMs) && nowMs - (createdMs as number) > seedEvalSlaMs) {
      offendingSignals.push({
        signalId: String(signal?.id || ""),
        symbol: String(signal?.ticker || "UNKNOWN"),
        createdAt,
        seedEvaluatedAt,
        ageMs,
      });
    }
  }

  const lastSeedAt = seedRun?.runAt ?? null;
  const lastExecuteAt = Number.isFinite(latestExecuteTs) ? new Date(latestExecuteTs).toISOString() : null;

  return {
    qualified,
    seeded,
    executed,
    freshQualifiedSignals,
    staleQualifiedSignals,
    totalQualifiedSignals: todayQualifiedSignals.length,
    staleThresholdUsedMs,
    eligibleCount,
    lastSeedAt,
    lastExecuteAt,
    lastSeedSource: seedRun?.source ?? null,
    lastSeedRunId: seedRun?.runId ?? null,
    latestSeedCreatedCount: Number(seedRun?.createdCount ?? 0),
    seedSkipReasonBreakdown: (seedRun?.skippedByReason as Record<string, number>) || {},
    executeSkipReasonBreakdown,
    executeNoAutoPendingCount,
    offendingSignals: offendingSignals.slice(0, 50),
    workflowChecks,
  };
}

async function triggerImmediateSeedRemediation(runId: string): Promise<{
  ok: boolean;
  status: number;
  diagnostics: Record<string, unknown> | null;
  bodyHead: string;
}> {
  const base =
    process.env.NEXT_PUBLIC_BASE_URL ||
    process.env.APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://127.0.0.1:3000");
  const token = process.env.CRON_TOKEN || process.env.CRON_SECRET || "";
  const url = `${base.replace(/\/+$/, "")}/api/auto-entry/seed-from-signals?limit=3`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cron-token": token,
        "x-run-source": "agent-ops-funnel-sla",
        "x-run-id": runId,
      },
      body: JSON.stringify({}),
      cache: "no-store",
    });
    const text = await response.text().catch(() => "");
    let diagnostics: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(text || "{}");
      if (parsed && typeof parsed === "object") diagnostics = parsed as Record<string, unknown>;
    } catch {}

    return {
      ok: response.ok,
      status: response.status,
      diagnostics,
      bodyHead: text.slice(0, 4000),
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      diagnostics: null,
      bodyHead: String(err || "seed_remediation_fetch_error").slice(0, 4000),
    };
  }
}

async function maybeCreateFunnelWorkflowTask(details: {
  runId: string;
  summary: string;
  workflowChecks: WorkflowChecks;
  seedDiagnostics: Record<string, unknown> | null;
  offendingSignals: FunnelMismatchDiagnostics["offendingSignals"];
}): Promise<string | null> {
  const { runId, summary, workflowChecks, seedDiagnostics, offendingSignals } = details;
  const suspectedWorkflowIssue =
    workflowChecks.minScoreThresholds.length > 0 ||
    workflowChecks.missingSteps.length > 0 ||
    workflowChecks.authHeaderIssues.length > 0;
  if (!suspectedWorkflowIssue) return null;

  const title = "Fix market-hours seed cadence and funnel SLA breach handling";
  const existing = await listManualActionTasks({ status: "OPEN", limit: 200 }).catch(() => []);
  const alreadyOpen = existing.some((task) => String(task?.title || "").trim().toLowerCase() === title.toLowerCase());
  if (alreadyOpen) return null;

  const task = await createManualActionTask({
    title,
    description:
      "Critical funnel block during market hours: qualified signals not progressing to seeded/execute stages. " +
      "Patch workflow cadence/order/auth and validate seed diagnostics explain all skips.",
    priority: "CRITICAL",
    taskType: "BUGFIX",
    executionReady: true,
    source: "ops_funnel_sla",
    objective: [
      `runId=${runId}`,
      `summary=${summary}`,
      `workflowMinScoreChecks=${JSON.stringify(workflowChecks.minScoreThresholds)}`,
      `workflowMissingSteps=${JSON.stringify(workflowChecks.missingSteps)}`,
      `workflowAuthHeaderIssues=${JSON.stringify(workflowChecks.authHeaderIssues)}`,
      `offendingSignals=${JSON.stringify(offendingSignals.slice(0, 25))}`,
      `seedDiagnostics=${JSON.stringify(seedDiagnostics || {}).slice(0, 1200)}`,
    ].join(" | "),
    fileHints: [
      ".github/workflows/market-loop.yml",
      ".github/workflows/intraday-score-worker.yml",
      ".github/workflows/auto-entry-execute.yml",
      ".github/workflows/auto-entry-seed-cadence.yml",
      "app/api/auto-entry/seed-from-signals/route.ts",
      "app/api/funnel-health/route.ts",
      "lib/agents/runners/ops.ts",
    ],
    routeHints: [
      "/api/ai/score/drain",
      "/api/auto-entry/seed-from-signals",
      "/api/auto-entry/execute",
      "/api/funnel-health",
      "/api/agents/run",
    ],
    acceptanceCriteria: [
      "Seed cadence runs every 5 minutes during market hours and logs HTTP status + diagnostics.",
      "No hard minScore workflow parameter (7.5) remains in scheduled seed calls.",
      "Fresh qualified signals receive seed evaluation <=10 minutes or CRITICAL FUNNEL_BLOCK is raised in-session.",
    ],
  }).catch(() => null);

  return task?.id ?? null;
}

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
  let funnelMismatchSummary: string | null = null;

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

  // ------- FUNNEL SLA ESCALATION + ACTIVE REMEDIATION -------
  const funnelDiag = await computeFunnelMismatchDiagnostics(now);
  const noAutoPendingThreshold = Number(process.env.AGENTS_NO_AUTO_PENDING_THRESHOLD ?? 3);
  const isMarketOpen = telemetry.marketOpen === true;

  const slaLatencyBreached = isMarketOpen && funnelDiag.offendingSignals.length > 0;
  const freshQualifiedNoSeed =
    isMarketOpen && funnelDiag.freshQualifiedSignals > 0 && funnelDiag.latestSeedCreatedCount === 0;
  const noPendingDespiteQualified =
    isMarketOpen &&
    funnelDiag.qualified > 0 &&
    funnelDiag.seeded === 0 &&
    funnelDiag.executeNoAutoPendingCount > 0;
  const repeatedNoAutoPending =
    isMarketOpen &&
    funnelDiag.executeNoAutoPendingCount >= noAutoPendingThreshold &&
    funnelDiag.freshQualifiedSignals > 0;

  const shouldEscalateFunnelBlock =
    slaLatencyBreached || freshQualifiedNoSeed || noPendingDespiteQualified || repeatedNoAutoPending;

  if (shouldEscalateFunnelBlock) {
    const remediationRunId = `ops-funnel-sla-${Date.now()}`;
    const seedRemediation = isMarketOpen
      ? await triggerImmediateSeedRemediation(remediationRunId)
      : { ok: false, status: 0, diagnostics: null, bodyHead: "market_closed_no_seed_remediation" };
    const remediationCreatedCount = Number(seedRemediation.diagnostics?.createdCount ?? 0);

    const breachReasons = [
      slaLatencyBreached ? "qualified_to_seed_latency_breach" : null,
      freshQualifiedNoSeed ? "fresh_qualified_but_no_seeding" : null,
      noPendingDespiteQualified ? "qualified_but_execute_no_auto_pending" : null,
      repeatedNoAutoPending ? "repeated_no_auto_pending_with_fresh_qualified" : null,
    ].filter(Boolean);

    const summary = [
      `breaches=${breachReasons.join(",")}`,
      `qualified=${funnelDiag.qualified}`,
      `freshQualifiedSignals=${funnelDiag.freshQualifiedSignals}`,
      `staleQualifiedSignals=${funnelDiag.staleQualifiedSignals}`,
      `seeded=${funnelDiag.seeded}`,
      `executed=${funnelDiag.executed}`,
      `seedRemediationCreatedCount=${remediationCreatedCount}`,
    ].join(" ");

    funnelMismatchSummary = `Funnel SLA breach detected during market hours. ${summary}.`;

    const seedSkippedQualifiedSignals = Array.isArray(seedRemediation.diagnostics?.skippedQualifiedSignals)
      ? (seedRemediation.diagnostics?.skippedQualifiedSignals as unknown[]).slice(0, 25)
      : [];
    const likelyRootCause = funnelDiag.workflowChecks.inspectionAvailable
      ? "Likely workflow cadence/order/auth mismatch or seed-time guardrail/capacity block."
      : "Workflow repository inspection unavailable at runtime; using seed/execute diagnostics and timestamp mismatch as primary evidence.";

    const notes = [
      `counts qualified=${funnelDiag.qualified} seeded=${funnelDiag.seeded} executed=${funnelDiag.executed}`,
      `freshQualifiedSignals=${funnelDiag.freshQualifiedSignals} staleQualifiedSignals=${funnelDiag.staleQualifiedSignals}`,
      `offendingSignalIds=${JSON.stringify(funnelDiag.offendingSignals.map((s) => s.signalId).slice(0, 50))}`,
      `offendingSignals=${JSON.stringify(funnelDiag.offendingSignals)}`,
      `staleThresholdUsedMs=${funnelDiag.staleThresholdUsedMs}`,
      `lastSeedAt=${funnelDiag.lastSeedAt ?? "null"} lastExecuteAt=${funnelDiag.lastExecuteAt ?? "null"}`,
      `lastSeedRunSource=${funnelDiag.lastSeedSource ?? "null"} lastSeedRunId=${funnelDiag.lastSeedRunId ?? "null"}`,
      `seedSkipReasonBreakdown=${JSON.stringify(funnelDiag.seedSkipReasonBreakdown)}`,
      `executeSkipReasonBreakdown=${JSON.stringify(funnelDiag.executeSkipReasonBreakdown)}`,
      `executeNoAutoPendingCount=${funnelDiag.executeNoAutoPendingCount}`,
      `seedRemediationStatus=${seedRemediation.status}`,
      `seedRemediationBodyHead=${seedRemediation.bodyHead}`,
      `seedRemediationDiagnostics=${JSON.stringify(seedRemediation.diagnostics || {})}`,
      `seedRemediationSkippedQualifiedSignals=${JSON.stringify(seedSkippedQualifiedSignals)}`,
      `workflowInspectionAvailable=${funnelDiag.workflowChecks.inspectionAvailable}`,
      `workflowMinScoreChecks=${JSON.stringify(funnelDiag.workflowChecks.minScoreThresholds)}`,
      `workflowMissingSteps=${JSON.stringify(funnelDiag.workflowChecks.missingSteps)}`,
      `workflowAuthHeaderIssues=${JSON.stringify(funnelDiag.workflowChecks.authHeaderIssues)}`,
      `likelyRootCause=${likelyRootCause}`,
      `proposedFix=${funnelDiag.workflowChecks.proposedFixes.join(" ")}`,
    ];

    const shouldEscalateAfterRemediation = remediationCreatedCount === 0;
    let taskId: string | null = null;

    if (shouldEscalateAfterRemediation) {
      const result = await upsertIncident({
        severity: "CRITICAL",
        source: "ops",
        category: "FUNNEL_BLOCK",
        title: "Funnel stage mismatch during market hours",
        summary: funnelMismatchSummary,
        notes,
      });
      if (result.created && !createdIncidentId) createdIncidentId = result.incident.id;

      taskId = await maybeCreateFunnelWorkflowTask({
        runId: remediationRunId,
        summary: funnelMismatchSummary,
        workflowChecks: funnelDiag.workflowChecks,
        seedDiagnostics: seedRemediation.diagnostics,
        offendingSignals: funnelDiag.offendingSignals,
      });
    } else {
      await resolveIncident(
        { category: "FUNNEL_BLOCK", title: "Funnel stage mismatch during market hours" },
        `Recovered after immediate seed remediation. runId=${remediationRunId} createdCount=${remediationCreatedCount}`,
      );
    }

    await appendAgentAction({
      id: crypto.randomUUID(),
      createdAt: now,
      agent: "ops",
      actionType: "INCIDENT_ESCALATED",
      status: "APPLIED",
      summary:
        shouldEscalateAfterRemediation
          ? `Escalated CRITICAL FUNNEL_BLOCK incident and executed immediate seed remediation (HTTP ${seedRemediation.status}).`
          : `Executed immediate seed remediation and recovered funnel progression (HTTP ${seedRemediation.status}, createdCount=${remediationCreatedCount}).`,
      metadata: {
        category: "FUNNEL_BLOCK",
        severity: "CRITICAL",
        breachReasons,
        counts: {
          qualified: funnelDiag.qualified,
          seeded: funnelDiag.seeded,
          executed: funnelDiag.executed,
          freshQualifiedSignals: funnelDiag.freshQualifiedSignals,
          staleQualifiedSignals: funnelDiag.staleQualifiedSignals,
        },
        seedRemediation: {
          attempted: isMarketOpen,
          status: seedRemediation.status,
          createdCount: remediationCreatedCount,
        },
        lastSeedAt: funnelDiag.lastSeedAt,
        lastExecuteAt: funnelDiag.lastExecuteAt,
        lastSeedSource: funnelDiag.lastSeedSource,
        lastSeedRunId: funnelDiag.lastSeedRunId,
        seedSkipReasonBreakdown: funnelDiag.seedSkipReasonBreakdown,
        executeSkipReasonBreakdown: funnelDiag.executeSkipReasonBreakdown,
        workflowChecks: funnelDiag.workflowChecks,
        engineeringTaskId: taskId,
      },
    });
  } else {
    await resolveIncident(
      { category: "FUNNEL_BLOCK", title: "Funnel stage mismatch during market hours" },
      "Funnel progression is healthy for current session or market is not open.",
    );
  }

  // ------- EXECUTE BLOCKER DETECTION -------
  // When seeded > 0, executed = 0, and execute marked trades MALFORMED or
  // SKIPPED_NO_LONGER_ELIGIBLE during market hours, this is a critical engineering
  // bug — not a data or capacity issue — and warrants an immediate task.
  {
    const executeBlockerCount =
      (funnelDiag.executeSkipReasonBreakdown["MALFORMED"] ?? 0) +
      (funnelDiag.executeSkipReasonBreakdown["SKIPPED_NO_LONGER_ELIGIBLE"] ?? 0) +
      (funnelDiag.executeSkipReasonBreakdown["SKIPPED_SCORE_THRESHOLD"] ?? 0);
    const shouldEscalateExecuteBlocker =
      isMarketOpen &&
      funnelDiag.seeded > 0 &&
      funnelDiag.executed === 0 &&
      executeBlockerCount > 0 &&
      funnelDiag.eligibleCount === 0;

    if (shouldEscalateExecuteBlocker) {
      const summary = [
        `seeded=${funnelDiag.seeded}`,
        `executed=${funnelDiag.executed}`,
        `eligibleCount=${funnelDiag.eligibleCount}`,
        `executeBlockerCount=${executeBlockerCount}`,
        `executeSkipReasonBreakdown=${JSON.stringify(funnelDiag.executeSkipReasonBreakdown)}`,
      ].join(" ");

      const result = await upsertIncident({
        severity: "CRITICAL",
        source: "ops",
        category: "FUNNEL_BLOCK",
        title: "Execute is blocking all seeded trades",
        summary: `CRITICAL: Seeded trades exist but execute validation is rejecting all of them. ${summary}`,
        notes: [
          `counts seeded=${funnelDiag.seeded} executed=${funnelDiag.executed} eligibleCount=${funnelDiag.eligibleCount}`,
          `executeSkipReasonBreakdown=${JSON.stringify(funnelDiag.executeSkipReasonBreakdown)}`,
          `lastSeedAt=${funnelDiag.lastSeedAt ?? "null"} lastExecuteAt=${funnelDiag.lastExecuteAt ?? "null"}`,
        ],
      });
      if (result.created && !createdIncidentId) createdIncidentId = result.incident.id;

      // Create a concrete engineering task so this is actionable
      const title = "Fix execute payload validation blocking seeded AUTO_PENDING trades";
      const existing = await listManualActionTasks({ status: "OPEN", limit: 200 }).catch(() => []);
      const alreadyOpen = existing.some(
        (task) => String(task?.title || "").trim().toLowerCase() === title.toLowerCase(),
      );
      if (!alreadyOpen) {
        await createManualActionTask({
          title,
          description:
            "Execute route is rejecting all seeded AUTO_PENDING trades with rescore_required or MALFORMED. " +
            "Seeded trades carrying a valid aiScore and tier must not require a second AI rescore at execute time. " +
            "Fix: ensure per-trade normalization (symbol/ticker/aiScore/tier cross-population) runs before eligibility evaluation, " +
            "and that isScoredTrade/rescoreAfterMin gate honours existing seed-validated scores.",
          priority: "CRITICAL",
          taskType: "BUGFIX",
          executionReady: true,
          source: "ops_execute_blocker",
          objective: [
            `seeded=${funnelDiag.seeded} executed=${funnelDiag.executed} eligibleCount=${funnelDiag.eligibleCount}`,
            `executeSkipReasonBreakdown=${JSON.stringify(funnelDiag.executeSkipReasonBreakdown)}`,
          ].join(" | "),
          fileHints: [
            "app/api/auto-entry/execute/route.ts",
            "lib/autoEntry/eligibility.ts",
            "app/api/auto-entry/seed-from-signals/route.ts",
          ],
          routeHints: [
            "/api/auto-entry/execute",
            "/api/auto-entry/seed-from-signals",
            "/api/funnel-health",
          ],
          acceptanceCriteria: [
            "A seeded AUTO_PENDING trade with aiScore > 0 and tier set is not rejected as rescore_required.",
            "Execute eligibleCount > 0 when pendingCount > 0 and seeded trades are fresh and valid.",
            "seededToExecuted conversion rate rises above 0 during market hours.",
          ],
        }).catch(() => null);
      }

      await appendAgentAction({
        id: crypto.randomUUID(),
        createdAt: now,
        agent: "ops",
        actionType: "INCIDENT_ESCALATED",
        status: "APPLIED",
        summary: `Escalated CRITICAL execute blocker: all ${funnelDiag.seeded} seeded trades rejected at execute validation. ${summary}`,
        metadata: {
          category: "FUNNEL_BLOCK",
          severity: "CRITICAL",
          executeBlockerCount,
          counts: {
            seeded: funnelDiag.seeded,
            executed: funnelDiag.executed,
            eligibleCount: funnelDiag.eligibleCount,
          },
          executeSkipReasonBreakdown: funnelDiag.executeSkipReasonBreakdown,
        },
      });
    } else {
      await resolveIncident(
        { category: "FUNNEL_BLOCK", title: "Execute is blocking all seeded trades" },
        `Execute blocker cleared: seeded=${funnelDiag.seeded} executed=${funnelDiag.executed} eligibleCount=${funnelDiag.eligibleCount} executeBlockerCount=${executeBlockerCount}.`,
      );
    }
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
      funnelMismatchSummary,
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