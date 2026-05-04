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
import { saveCriticalTask } from "@/lib/redis";
import { AGENT_FUNNEL_RECOVERY_KEY, AGENT_MARKET_OPEN_SINCE_KEY } from "@/lib/agents/keys";
import {
  createManualActionTask,
  findDuplicateManualTask,
  type ManualActionTaskType,
} from "@/lib/agents/manual-action-queue";
import { nowIso } from "@/lib/agents/time";

// ─── Types ─────────────────────────────────────────────────────────────

export type FunnelBlockedStage = "scan" | "signals" | "scoring" | "entry" | "unknown";

/**
 * Enriched funnel context populated from live funnel-health data.
 * Used by createFunnelRecoveryTasks to select the right recovery action.
 */
export interface FunnelRecoveryContext {
  candidates: number;
  signalsReceived: number;
  scored: number;
  marketOpen: boolean;
  /** Minutes since the market was first detected open this session (null if unknown). */
  minsMarketOpen: number | null;
  /**
   * Estimated ratio of signals that failed bars/data checks: (received - scored) / received.
   * null when signalsReceived = 0 (no basis for estimation).
   */
  missingBarsRatio: number | null;
}

export interface FunnelRecoveryState {
  funnelBlocked: boolean;
  funnelBlockedReason: string | null;
  funnelBlockedStage: FunnelBlockedStage | null;
  funnelRecoveryMode: boolean;
  lastFunnelBlockedAt: string | null;
  lastFunnelHealthyAt: string | null;
  /** Enriched live context for recovery action dispatch. Optional; absent in legacy stored states. */
  context?: FunnelRecoveryContext | null;
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

    // ── Track market-open since for duration-sensitive conditions ──────
    // Record the ISO timestamp of first detection each session.
    // Cleared when market closes so it resets cleanly each day.
    let minsMarketOpen: number | null = null;
    if (redis) {
      if (marketOpen) {
        try {
          const storedOpenAt = await redis.get<string>(AGENT_MARKET_OPEN_SINCE_KEY).catch(() => null);
          if (!storedOpenAt) {
            const openAt = nowIso();
            await redis.set(AGENT_MARKET_OPEN_SINCE_KEY, openAt, { ex: 60 * 60 * 14 }).catch(() => {});
            minsMarketOpen = 0;
          } else {
            const openAtMs = Date.parse(storedOpenAt);
            minsMarketOpen = Number.isFinite(openAtMs)
              ? Math.round((Date.now() - openAtMs) / 60_000)
              : null;
          }
        } catch {
          // non-fatal
        }
      } else {
        // Market closed — reset tracker for next session
        await redis.del(AGENT_MARKET_OPEN_SINCE_KEY).catch(() => {});
      }
    }

    const rawCandidates = Number(funnel.candidates ?? 0);
    const rawSignalsReceived = Number(funnel.signalsReceived ?? 0);
    const rawScored = Number(funnel.scored ?? 0);

    // Missing-bars ratio: fraction of received signals that never reached scoring
    const missingBarsRatio: number | null =
      rawSignalsReceived > 0
        ? Math.max(0, Math.min(1, (rawSignalsReceived - rawScored) / rawSignalsReceived))
        : null;

    const d: FunnelStageData = {
      candidates: rawCandidates,
      signalsReceived: rawSignalsReceived,
      scored: rawScored,
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

    // Live context carried through to task creation
    const liveContext: FunnelRecoveryContext = {
      candidates: rawCandidates,
      signalsReceived: rawSignalsReceived,
      scored: rawScored,
      marketOpen,
      minsMarketOpen,
      missingBarsRatio,
    };

    if (!marketOpen && !hasActivity) {
      // Outside market hours with no activity — not blocked, just idle
      const idleState: FunnelRecoveryState = {
        funnelBlocked: false,
        funnelBlockedReason: null,
        funnelBlockedStage: null,
        funnelRecoveryMode: false,
        lastFunnelBlockedAt: existing.lastFunnelBlockedAt,
        lastFunnelHealthyAt: existing.lastFunnelHealthyAt,
        context: liveContext,
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
        context: liveContext,
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
      context: liveContext,
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
 *
 * When funnelBlocked=true AND marketOpen=true, four specific action patterns
 * are evaluated in priority order (highest severity first):
 *
 *   4. HARD_FAIL_ESCALATION  — zero signals for > 15 min → CRITICAL + critical queue
 *   3. ZERO_SIGNAL_GUARDRAIL — zero signals for > 5 min  → force-post top candidates
 *   1. SCAN_SIGNAL_FAILURE   — candidates > 0 but 0 posted → relax thresholds + fallback
 *   2. MISSING_BARS_RECOVERY — scored/received < 0.8       → expand lookback + fallback
 *
 * A generic stage-based task is created as fallback when no pattern applies.
 * All tasks deduplicate against existing OPEN/SELECTED/IN_PROGRESS/BLOCKED tasks.
 * Returns total count of new tasks created.
 */
export async function createFunnelRecoveryTasks(
  state: FunnelRecoveryState,
): Promise<number> {
  if (!state.funnelBlocked) return 0;

  const ctx = state.context;
  const marketOpen = ctx?.marketOpen ?? false;

  // When market is closed, only create generic stage-based maintenance task
  if (!marketOpen) {
    return createStageRecoveryTask(state);
  }

  const candidates = ctx?.candidates ?? 0;
  const signalsReceived = ctx?.signalsReceived ?? 0;
  const scored = ctx?.scored ?? 0;
  const minsMarketOpen = ctx?.minsMarketOpen ?? null;
  const missingBarsRatio = ctx?.missingBarsRatio ?? null;
  const blockedReason = state.funnelBlockedReason ?? "unknown";

  let created = 0;

  // ─── Action 4: HARD FAIL ESCALATION ──────────────────────────────────
  // Conditions: signalsReceived=0 AND market open > 15 min
  // Actions:    CRITICAL manual task + critical queue injection → bypasses all optimization
  if (signalsReceived === 0 && minsMarketOpen !== null && minsMarketOpen > 15) {
    const title = "CRITICAL: scanner_signal_generation_blocked — zero signals >15m";
    const existing = await findDuplicateManualTask(title, "SELF_HEAL").catch(() => null);
    if (!existing) {
      const task = await createManualActionTask({
        title,
        description:
          `[HARD FAIL ESCALATION] Zero signals received for ${minsMarketOpen} minutes during market hours.\n\n` +
          `ALL signal generation has failed. This task bypasses all optimization work.\n\n` +
          `Candidates found by scanner: ${candidates}\n\n` +
          `Required actions:\n` +
          `1. Check scanner authentication tokens (ALPACA_API_KEY, ALPACA_API_SECRET)\n` +
          `2. Diagnose /api/signals POST endpoint for 4xx/5xx errors\n` +
          `3. Verify signal persistence in Redis signalsStore\n` +
          `4. Check /api/readiness for infrastructure failures (Redis, Alpaca connectivity)\n` +
          `5. If scanner is running but signals not posting: inspect signal filter thresholds\n\n` +
          `Blocked reason: ${blockedReason}`,
        priority: "CRITICAL",
        taskType: "SELF_HEAL",
        executionReady: true,
        fileHints: [
          "app/api/signals/route.ts",
          "lib/signalsStore.ts",
          "app/api/scan/route.ts",
          "app/api/readiness/route.ts",
        ],
        routeHints: ["/api/signals", "/api/readiness", "/api/funnel-health", "/api/scan"],
        source: "funnel_recovery",
        objective: "Restore signal generation immediately — CRITICAL funnel block",
        acceptanceCriteria: [
          "signalsReceived > 0 within next 5 minutes",
          "funnel-health shows no zero-signal incident",
        ],
      }).catch(() => null);
      if (task) created++;
    }

    // Also inject into critical task queue so execute route's resolver picks it up
    await saveCriticalTask({
      incidentCode: "SIGNAL_GENERATION_BLOCKED",
      symbol: "SYSTEM",
      severity: "CRITICAL",
      detail: `Zero signals for ${minsMarketOpen}m during market hours. candidates=${candidates}. Funnel hard-blocked.`,
    }).catch(() => {});
  }

  // ─── Action 3: ZERO SIGNAL DAY GUARDRAIL ─────────────────────────────
  // Conditions: signalsReceived=0 AND market open > 5 min
  // Actions:    Force-post top 1–2 candidates regardless of soft filters
  if (signalsReceived === 0 && minsMarketOpen !== null && minsMarketOpen > 5) {
    const title = "Zero-signal guardrail: force-post top candidates in recovery mode";
    const existing = await findDuplicateManualTask(title, "SCANNER").catch(() => null);
    if (!existing) {
      const task = await createManualActionTask({
        title,
        description:
          `[ZERO SIGNAL DAY GUARDRAIL] Market has been open ${minsMarketOpen} minutes with 0 signals received.\n\n` +
          `Required actions:\n` +
          `1. Force-post top 1–2 candidates regardless of soft filter thresholds\n` +
          `2. Mark signals as recovery_mode=true to bypass quality gates\n` +
          `3. Relax relVol threshold by 10–20% (e.g. minRelVol * 0.8)\n` +
          `4. Log forcedPostFallback=true on every force-posted signal\n` +
          `5. Target: get at least 1 signal into the store within next scan cycle\n\n` +
          `Blocked reason: ${blockedReason}`,
        priority: "CRITICAL",
        taskType: "SCANNER",
        executionReady: true,
        fileHints: [
          "app/api/scan/route.ts",
          "app/api/signals/route.ts",
          "lib/signals/since.ts",
        ],
        routeHints: ["/api/scan", "/api/signals", "/api/funnel-health"],
        source: "funnel_recovery",
        objective: "Force at least 1 signal into the store to unblock the zero-signal day",
        acceptanceCriteria: [
          "signalsReceived >= 1 after force-post",
          "forcedPostFallback=true present on signal record",
          "funnel-health signalsReceived > 0",
        ],
      }).catch(() => null);
      if (task) created++;
    }
  }

  // ─── Action 1: SCAN → SIGNAL POSTING FAILURE ─────────────────────────
  // Conditions: candidates > 0 AND signalsReceived = 0
  // Actions:    Relax thresholds + allow force-post fallback for top candidates
  if (candidates > 0 && signalsReceived === 0) {
    const title = "Fix scan→signal posting failure: relax thresholds + force-post fallback";
    const existing = await findDuplicateManualTask(title, "SCANNER").catch(() => null);
    if (!existing) {
      const task = await createManualActionTask({
        title,
        description:
          `[SCAN→SIGNAL POSTING FAILURE] ${candidates} candidate(s) found by scanner but 0 signals posted.\n\n` +
          `Required actions:\n` +
          `1. Relax relVol threshold by 10–20% (multiply current minRelVol threshold by 0.8)\n` +
          `2. Relax trend strength requirement slightly (reduce minTrendScore by 0.1)\n` +
          `3. Allow fallback posting for top 1–3 candidates when all soft filters reject\n` +
          `4. Set forcedPostFallback=true on fallback-posted signals for audit trail\n` +
          `5. Ensure fallback path does NOT bypass hard risk limits (minPrice, volatility caps)\n\n` +
          `Blocked reason: ${blockedReason}`,
        priority: "CRITICAL",
        taskType: "SCANNER",
        executionReady: true,
        fileHints: [
          "app/api/scan/route.ts",
          "lib/scanner/prePostGating.ts",
          "app/api/signals/route.ts",
        ],
        routeHints: ["/api/scan", "/api/signals", "/api/signals/all"],
        source: "funnel_recovery",
        objective: "Unblock scan→signal pipeline with threshold relaxation + force-post fallback",
        acceptanceCriteria: [
          "signalsReceived > 0 after next scan cycle",
          "No candidates dropped when fallback is active and soft filters reject all",
          "forcedPostFallback=true present in signal payload when fallback used",
        ],
      }).catch(() => null);
      if (task) created++;
    }
  }

  // ─── Action 2: MISSING BARS FAILURE ──────────────────────────────────
  // Conditions: missingBarsRatio > 0.2 (>20% of signals fail bars fetch)
  // Actions:    Expand lookback window + rolling-window fallback + prior-session bars
  if (missingBarsRatio !== null && missingBarsRatio > 0.2) {
    const missingPct = Math.round(missingBarsRatio * 100);
    const title = "Recover missing bars: expand lookback + rolling window fallback";
    const existing = await findDuplicateManualTask(title, "SCORING").catch(() => null);
    if (!existing) {
      const task = await createManualActionTask({
        title,
        description:
          `[MISSING BARS FAILURE] ~${missingPct}% of signals are failing bars fetch ` +
          `(signalsReceived=${signalsReceived}, scored=${scored}).\n\n` +
          `Required actions:\n` +
          `1. Re-fetch bars using rolling window fallback on any 404/empty response\n` +
          `2. Expand lookback window: 1-min bars → 60 min window (from default 30 min)\n` +
          `3. Fall back to prior session bars if intraday bars unavailable\n` +
          `4. Log barsFallbackUsed=true on every signal that uses fallback bars\n` +
          `5. Add retry with exponential backoff (max 3 attempts) before rejecting signal\n\n` +
          `Blocked reason: ${blockedReason}`,
        priority: "HIGH",
        taskType: "SCORING",
        executionReady: true,
        fileHints: [
          "lib/aiScoring.ts",
          "lib/barWindow.ts",
          "app/api/ai/score/drain/route.ts",
        ],
        routeHints: ["/api/ai/score/drain", "/api/ai/health", "/api/signals/all"],
        source: "funnel_recovery",
        objective: "Fix bars fetch failures to unblock the AI scoring pipeline",
        acceptanceCriteria: [
          `scored/signalsReceived ratio > 0.8 (currently ~${(1 - missingBarsRatio).toFixed(2)})`,
          "barsFallbackUsed=true logged when fallback activates",
          "No increase in BARS_UNAVAILABLE rejections after fix",
        ],
      }).catch(() => null);
      if (task) created++;
    }
  }

  // ─── Fallback: generic stage-based task if no pattern matched ─────────
  if (created === 0) {
    created += await createStageRecoveryTask(state);
  }

  return created;
}

/**
 * Create the generic stage-based recovery task (original behaviour).
 * Used as fallback when no specific action pattern applies, and during market-closed hours.
 */
async function createStageRecoveryTask(state: FunnelRecoveryState): Promise<number> {
  if (!state.funnelBlockedStage) return 0;

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
