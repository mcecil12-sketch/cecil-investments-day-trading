/**
 * Funnel Recovery — Agent Workflow v2
 *
 * Detects when the trading funnel is blocked and provides:
 *   - Funnel blocked state detection (during market hours)
 *   - Stage classification: scan → signals → scoring → entry
 *   - Task allow/block filtering for recovery mode
 *   - Auto-creation of recovery tasks when blocked
 *
 * When funnelBlocked=true the execute route allows ONLY recovery tasks
 * and blocks all scoring optimization / exit optimization / profit engine
 * / adaptive suppression work.
 */

import { redis } from "@/lib/redis";
import { AGENT_FUNNEL_RECOVERY_KEY } from "@/lib/agents/keys";
import {
  createManualActionTask,
  findDuplicateManualTask,
  type ManualActionTaskType,
} from "@/lib/agents/manual-action-queue";
import { nowIso } from "@/lib/agents/time";

// ─── Types ─────────────────────────────────────────────────────────────

export type FunnelBlockedStage = "scan" | "signals" | "scoring" | "entry" | "unknown";

export interface FunnelRecoveryState {
  funnelBlocked: boolean;
  funnelBlockedReason: string | null;
  funnelBlockedStage: FunnelBlockedStage | null;
  funnelRecoveryMode: boolean;
  lastFunnelBlockedAt: string | null;
  lastFunnelHealthyAt: string | null;
}

const FUNNEL_RECOVERY_TTL = 24 * 60 * 60; // 24 hours

// ─── Recovery mode allow / block lists ────────────────────────────────

// Task types allowed in recovery mode (ManualActionTask.taskType)
const RECOVERY_ALLOWED_TASK_TYPES: Set<string> = new Set([
  "BUGFIX",
  "SELF_HEAL",
  "OPS",
  "SCORING",
  "SCANNER",
  "AUTO_ENTRY",
]);

// Keywords in task title/description that indicate a recovery-mode-allowed task
const RECOVERY_ALLOWED_PATTERNS: RegExp[] = [
  /\bscanner\b/i,
  /\bscan\b/i,
  /\bsignal(s)?\b/i,
  /\bscoring\b/i,
  /\bscore\b/i,
  /auto.?entry/i,
  /\bseed\b/i,
  /\bauth\b/i,
  /\btoken\b/i,
  /\bredis\b/i,
  /pipeline/i,
  /\bfunnel\b/i,
  /\bdrain\b/i,
  /\bbacklog\b/i,
  /\breject\b/i,
  /\btimeout\b/i,
  /deadline/i,
  /infrastructure/i,
  /\binfra\b/i,
  /integrity/i,
  /\bbroker\b/i,
  /critical/i,
  /recovery/i,
  /repair/i,
  /diagnos/i,
  /\bfix\b.*(?:scan|signal|scor|seed|entry|auth|pipeline)/i,
];

// Keywords that identify optimization-only tasks, blocked in recovery mode
const OPTIMIZATION_BLOCKED_PATTERNS: RegExp[] = [
  /\[ProfitEngine\]/i,
  /\[Adaptive\]/i,
  /adaptive.?guardrail/i,
  /profit.?engine/i,
  /exit.?optim/i,
  /profit.?optim/i,
  /win.?rate.?tun/i,
  /avg.?r.?tun/i,
  /scoring.?optim/i,
  /tier.?optim/i,
  /adaptive.?suppression/i,
  /performance.?pattern/i,
  /experiment.?tracker/i,
];

/**
 * Determine whether a task is allowed when the funnel is in recovery mode.
 *
 * Returns true when:
 *   - task is CRITICAL priority (always allowed)
 *   - taskType is one of the recovery-allowed types
 *   - title contains a recovery keyword AND does not contain an optimization keyword
 */
export function isFunnelRecoveryTask(task: {
  taskType?: string | null;
  title: string;
  priority?: string | null;
}): boolean {
  // Critical tasks always allowed
  if (task.priority && task.priority.toUpperCase() === "CRITICAL") return true;

  // Optimization-only tasks are blocked first (most specific check)
  const text = task.title;
  if (OPTIMIZATION_BLOCKED_PATTERNS.some((p) => p.test(text))) return false;

  // Task type check (ManualActionTask)
  if (task.taskType && RECOVERY_ALLOWED_TASK_TYPES.has(task.taskType.toUpperCase())) return true;

  // Keyword check
  return RECOVERY_ALLOWED_PATTERNS.some((p) => p.test(text));
}

/**
 * Returns true when a task is optimization-only and should be blocked in recovery mode.
 */
export function isOptimizationOnlyTask(task: { title: string; taskType?: string | null }): boolean {
  return OPTIMIZATION_BLOCKED_PATTERNS.some((p) => p.test(task.title));
}

// ─── Funnel blocked detection ─────────────────────────────────────────

interface FunnelStageData {
  candidates: number;
  signalsReceived: number;
  scored: number;
  qualified: number;
  seeded: number;
  scoringErrors: number;
  pendingInStore: number;
  minsSinceLastScan: number | null;
  stoppedStage: string | null;
  stoppedReason: string | null;
  marketOpen: boolean;
  hasBlockingIncident: boolean;
  incidentCodes: string[];
}

function classifyBlockedStage(d: FunnelStageData): FunnelBlockedStage {
  // Use explicit stopped-stage from funnelFlowDiagnostics when available
  if (d.stoppedStage) {
    if (/scan/i.test(d.stoppedStage)) return "scan";
    if (/signal/i.test(d.stoppedStage)) return "signals";
    if (/scor/i.test(d.stoppedStage)) return "scoring";
    if (/seed|entry/i.test(d.stoppedStage)) return "entry";
  }

  // Scanner stale
  if (d.minsSinceLastScan !== null && d.minsSinceLastScan > 20 && d.candidates === 0) return "scan";

  // Flow breakdowns
  if (d.candidates > 0 && d.signalsReceived === 0) return "signals";
  if (d.signalsReceived > 0 && d.scored === 0) return "scoring";
  if (d.scored > 0 && d.qualified === 0) return "scoring";
  if (d.qualified > 0 && d.seeded === 0) return "entry";

  // Scoring backlog / errors
  if (d.scoringErrors > 5 || d.pendingInStore > 10) return "scoring";

  // Incident-based classification
  if (d.incidentCodes.some((c) => /SIGNAL_FLOW/.test(c))) return "signals";
  if (d.incidentCodes.some((c) => /SCORING/.test(c))) return "scoring";
  if (d.incidentCodes.some((c) => /QUALIFIED_NOT_SEEDED|UNDERUTILIZED/.test(c))) return "entry";

  return "unknown";
}

function buildBlockedReason(d: FunnelStageData, stage: FunnelBlockedStage): string {
  if (d.stoppedReason) return d.stoppedReason;

  switch (stage) {
    case "scan":
      return d.minsSinceLastScan !== null
        ? `Scanner stale: no scan in ${d.minsSinceLastScan}m`
        : "Scanner stale: no candidates found during market hours";
    case "signals":
      return `Signal flow broken: candidates=${d.candidates} but signalsReceived=0`;
    case "scoring":
      if (d.scoringErrors > 5) return `Scoring pipeline failing: ${d.scoringErrors} errors today`;
      if (d.pendingInStore > 10) return `Scoring backlog: ${d.pendingInStore} pending signals unprocessed`;
      return `Scoring blocked: signalsReceived=${d.signalsReceived} but scored=0`;
    case "entry":
      return `Entry blocked: qualified=${d.qualified} but seeded=0 — freshness/minScore/capacity gate`;
    default:
      return `Funnel blocked: marketOpen=${d.marketOpen} candidates=${d.candidates} signals=${d.signalsReceived} scored=${d.scored}`;
  }
}

/**
 * Detect if the trading funnel is currently blocked.
 * Reads from the /api/funnel-health endpoint and persists the result in Redis.
 *
 * Only detects blockage during market hours (marketOpen=true or candidates > 0).
 */
export async function detectFunnelBlockedState(baseUrl: string): Promise<FunnelRecoveryState> {
  const existing = await readFunnelRecoveryState();

  try {
    const res = await fetch(`${baseUrl}/api/funnel-health`, {
      headers: { "cache-control": "no-store" },
      signal: AbortSignal.timeout(8_000),
    }).catch(() => null);

    if (!res || !res.ok) return existing;

    const data = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (!data) return existing;

    const funnel = (data.funnel ?? {}) as Record<string, unknown>;
    const incidents = (data.incidents as Array<{ code: string; severity: string }>) ?? [];
    const diagnostics = (data.funnelFlowDiagnostics ?? {}) as Record<string, unknown>;
    const timestamps = (data.timestamps ?? {}) as Record<string, unknown>;
    const marketOpen = Boolean(data.marketOpen);

    const d: FunnelStageData = {
      candidates: Number(funnel.candidates ?? 0),
      signalsReceived: Number(funnel.signalsReceived ?? 0),
      scored: Number(funnel.scored ?? 0),
      qualified: Number(funnel.qualified ?? 0),
      seeded: Number(funnel.seeded ?? 0),
      scoringErrors: 0, // estimated from incidents
      pendingInStore: 0, // estimated
      minsSinceLastScan: typeof timestamps.minsSinceLastSeed === "number"
        ? timestamps.minsSinceLastSeed
        : null,
      stoppedStage: typeof diagnostics.stoppedAt === "string" ? diagnostics.stoppedAt : null,
      stoppedReason: typeof diagnostics.stoppedReason === "string" ? diagnostics.stoppedReason : null,
      marketOpen,
      hasBlockingIncident: incidents.some(
        (i) => i.severity === "CRITICAL" || i.severity === "HIGH",
      ),
      incidentCodes: incidents.map((i) => i.code),
    };

    // Count scoring-related errors from incidents
    const scoringIncidents = incidents.filter(
      (i) => /SCORING/.test(i.code) && (i.severity === "CRITICAL" || i.severity === "HIGH"),
    );
    d.scoringErrors = scoringIncidents.length * 3; // escalate weight

    // Determine if funnel is blocked
    // Only evaluate during market hours OR when there's scan activity
    const hasActivity = d.candidates > 0 || d.signalsReceived > 0 || d.scored > 0;
    if (!marketOpen && !hasActivity) {
      // Outside market hours with no activity — not blocked, just idle
      const idleState: FunnelRecoveryState = {
        funnelBlocked: false,
        funnelBlockedReason: null,
        funnelBlockedStage: null,
        funnelRecoveryMode: false,
        lastFunnelBlockedAt: existing.lastFunnelBlockedAt,
        lastFunnelHealthyAt: existing.lastFunnelHealthyAt,
      };
      return idleState;
    }

    // Check for flow breakdowns (order matters: first match wins)
    const hasFlowBreakdown =
      (d.candidates > 0 && d.signalsReceived === 0) ||
      (d.signalsReceived > 0 && d.scored === 0) ||
      (d.scored > 0 && d.qualified === 0) ||
      (d.qualified > 0 && d.seeded === 0);

    const hasScoringIssues = d.scoringErrors > 5 || d.pendingInStore > 10;
    const hasScannerStale =
      d.minsSinceLastScan !== null && d.minsSinceLastScan > 20 && marketOpen;

    // Blocking incidents (CRITICAL/HIGH severity, system-broken type)
    const hasCriticalIncident = incidents.some(
      (i) =>
        (i.severity === "CRITICAL" || i.severity === "HIGH") &&
        /SIGNAL_FLOW|SCORING_DEGRADED|PROTECTION_MISSING|MISSING_STOP/.test(i.code),
    );

    const isBlocked = hasCriticalIncident || hasFlowBreakdown || hasScoringIssues || hasScannerStale;

    if (!isBlocked) {
      const healthy: FunnelRecoveryState = {
        funnelBlocked: false,
        funnelBlockedReason: null,
        funnelBlockedStage: null,
        funnelRecoveryMode: false,
        lastFunnelBlockedAt: existing.lastFunnelBlockedAt,
        lastFunnelHealthyAt: nowIso(),
      };
      await writeFunnelRecoveryState(healthy);
      return healthy;
    }

    const stage = classifyBlockedStage(d);
    const reason = buildBlockedReason(d, stage);

    const blocked: FunnelRecoveryState = {
      funnelBlocked: true,
      funnelBlockedReason: reason,
      funnelBlockedStage: stage,
      funnelRecoveryMode: true,
      lastFunnelBlockedAt: nowIso(),
      lastFunnelHealthyAt: existing.lastFunnelHealthyAt,
    };
    await writeFunnelRecoveryState(blocked);
    return blocked;
  } catch (err) {
    console.warn("[FUNNEL-RECOVERY] Detection failed (non-fatal):", err);
    return existing;
  }
}

// ─── Redis persistence ─────────────────────────────────────────────────

export async function readFunnelRecoveryState(): Promise<FunnelRecoveryState> {
  if (!redis) return emptyRecoveryState();
  try {
    const raw = await redis.get<FunnelRecoveryState>(AGENT_FUNNEL_RECOVERY_KEY);
    if (!raw || typeof raw !== "object") return emptyRecoveryState();
    return raw as FunnelRecoveryState;
  } catch {
    return emptyRecoveryState();
  }
}

async function writeFunnelRecoveryState(state: FunnelRecoveryState): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(AGENT_FUNNEL_RECOVERY_KEY, state, { ex: FUNNEL_RECOVERY_TTL });
  } catch {
    // non-fatal
  }
}

function emptyRecoveryState(): FunnelRecoveryState {
  return {
    funnelBlocked: false,
    funnelBlockedReason: null,
    funnelBlockedStage: null,
    funnelRecoveryMode: false,
    lastFunnelBlockedAt: null,
    lastFunnelHealthyAt: null,
  };
}

// ─── Auto-create recovery tasks ─────────────────────────────────────────

interface RecoveryTaskDef {
  title: string;
  description: string;
  taskType: ManualActionTaskType;
  fileHints: string[];
  routeHints: string[];
}

const RECOVERY_TASK_MAP: Record<FunnelBlockedStage, RecoveryTaskDef> = {
  scan: {
    title: "Diagnose scanner stale pipeline",
    description:
      "Scanner has not run recently during market hours. " +
      "Investigate /api/scan route, cron scheduler, scanner auth tokens, " +
      "and validate scanner health via /api/readiness.",
    taskType: "SCANNER",
    fileHints: [
      "app/api/scan/route.ts",
      "lib/scanner/scanner.ts",
    ],
    routeHints: ["/api/scan", "/api/readiness"],
  },
  signals: {
    title: "Fix scan → signals flow failure",
    description:
      "Candidates found but no signals posted. " +
      "Diagnose /api/signals POST failures, validate auth tokens, " +
      "and verify signal persistence to the store.",
    taskType: "SELF_HEAL",
    fileHints: [
      "app/api/signals/route.ts",
      "lib/signalsStore.ts",
    ],
    routeHints: ["/api/signals", "/api/signals/all", "/api/readiness"],
  },
  scoring: {
    title: "Fix AI scoring pipeline backlog",
    description:
      "Signals posted but not scored. " +
      "Run /api/ai/score/drain diagnostics, check for timeouts and deadline_exceeded errors, " +
      "inspect reject reasons (bars, volume, etc.), validate Alpaca auth tokens.",
    taskType: "SCORING",
    fileHints: [
      "app/api/ai/score/drain/route.ts",
      "lib/aiScoring.ts",
    ],
    routeHints: ["/api/ai/score/drain", "/api/ai/health", "/api/signals/all"],
  },
  entry: {
    title: "Fix scored signals not seeding into trades",
    description:
      "Signals scored but not seeding. " +
      "Check seed route freshness window (freshMs), minScore gate, " +
      "duplicate-signal deduplication logic, and rejection reasons.",
    taskType: "AUTO_ENTRY",
    fileHints: [
      "app/api/auto-entry/seed-from-signals/route.ts",
      "lib/autoEntry/seed.ts",
      "lib/autoEntry/guardrails.ts",
    ],
    routeHints: ["/api/auto-entry/seed-from-signals", "/api/funnel-health", "/api/readiness"],
  },
  unknown: {
    title: "Diagnose funnel blockage (unknown stage)",
    description:
      "Funnel appears blocked but exact stage is unclear. " +
      "Check scanner, signals, scoring, and entry routes for errors. " +
      "Review /api/funnel-health incidents for root cause.",
    taskType: "SELF_HEAL",
    fileHints: [
      "app/api/funnel-health/route.ts",
      "app/api/readiness/route.ts",
    ],
    routeHints: ["/api/funnel-health", "/api/readiness", "/api/signals/all"],
  },
};

/**
 * Auto-create recovery tasks appropriate for the blocked funnel stage.
 * Deduplicates against existing tasks in the manual queue.
 * Returns count of tasks created.
 */
export async function createFunnelRecoveryTasks(
  state: FunnelRecoveryState,
): Promise<number> {
  if (!state.funnelBlocked || !state.funnelBlockedStage) return 0;

  const def = RECOVERY_TASK_MAP[state.funnelBlockedStage];
  if (!def) return 0;

  const existing = await findDuplicateManualTask(def.title, def.taskType).catch(() => null);
  if (existing) return 0;

  const task = await createManualActionTask({
    title: def.title,
    description:
      `[Funnel Recovery Mode] ${def.description}\n\n` +
      `Blocked reason: ${state.funnelBlockedReason ?? "unknown"}`,
    priority: "HIGH",
    taskType: def.taskType,
    executionReady: true,
    fileHints: def.fileHints,
    routeHints: def.routeHints,
    source: "funnel_recovery",
    objective: `Restore funnel flow at ${state.funnelBlockedStage} stage`,
  }).catch(() => null);

  return task ? 1 : 0;
}
