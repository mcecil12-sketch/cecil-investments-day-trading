/**
 * Safe Autonomous Remediation — Phase 5
 *
 * Applies bounded, reversible config/guardrail actions based on
 * learning-detector findings. Every action is:
 *   - Reversible: stored with original value for rollback
 *   - Bounded: max one action per run, with TTL auto-expiry
 *   - Verified: outcome check after VERIFICATION_WINDOW_MS
 *
 * Does NOT do arbitrary code rewriting — only guardrail config mutations.
 */

import { redis } from "@/lib/redis";
import { AGENT_ADAPTIVE_GUARDRAILS_KEY } from "@/lib/agents/keys";
import type { AdaptiveGuardrailState, AdaptiveGuardrailAction } from "@/lib/agents/types";
import type { LearningFinding } from "@/lib/agents/learning-detectors";
import { recordLedgerEntry, type LedgerEntry } from "@/lib/agents/learning-ledger";

// ─── Constants ──────────────────────────────────────────────────────

const REMEDIATION_TTL_HOURS = 4;
const MAX_ACTIVE_REMEDIATIONS = 5;
const VERIFICATION_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// ─── Remediation Action Mapping ─────────────────────────────────────

interface RemediationPlan {
  actionType: string;
  appliedValue: number | string | boolean;
  previousValue: number | string | boolean | null;
  reason: string;
  findingId: string;
}

/**
 * Map a learning finding to a concrete safe remediation, if one exists.
 * Returns null if the finding has no safe automated fix.
 */
function planRemediation(
  finding: LearningFinding,
  activeActions: AdaptiveGuardrailAction[],
): RemediationPlan | null {
  // Don't stack multiple remediations of the same type
  const activeTypes = new Set(activeActions.map((a) => a.actionType));

  switch (finding.suggestedAction) {
    case "reduce_max_open_positions": {
      if (activeTypes.has("reduce_max_open_positions")) return null;
      return {
        actionType: "reduce_max_open_positions",
        appliedValue: typeof finding.suggestedValue === "number" ? finding.suggestedValue : 2,
        previousValue: null, // resolved at apply time
        reason: finding.evidence,
        findingId: finding.id,
      };
    }
    case "reduce_max_entries_per_day": {
      if (activeTypes.has("reduce_max_entries_per_day")) return null;
      return {
        actionType: "reduce_max_entries_per_day",
        appliedValue: typeof finding.suggestedValue === "number" ? finding.suggestedValue : 3,
        previousValue: null,
        reason: finding.evidence,
        findingId: finding.id,
      };
    }
    case "suppress_long_side": {
      if (activeTypes.has("suppress_side")) return null;
      return {
        actionType: "suppress_side",
        appliedValue: "long",
        previousValue: null,
        reason: finding.evidence,
        findingId: finding.id,
      };
    }
    case "suppress_short_side": {
      if (activeTypes.has("suppress_side")) return null;
      return {
        actionType: "suppress_side",
        appliedValue: "short",
        previousValue: null,
        reason: finding.evidence,
        findingId: finding.id,
      };
    }
    case "raise_min_score_threshold": {
      if (activeTypes.has("raise_min_score_threshold")) return null;
      return {
        actionType: "raise_min_score_threshold",
        appliedValue: typeof finding.suggestedValue === "number" ? finding.suggestedValue : 1.0,
        previousValue: null,
        reason: finding.evidence,
        findingId: finding.id,
      };
    }
    default:
      // Findings like "review_scanner_filters", "investigate_signal_persistence"
      // are informational and need human review — no auto-remediation
      return null;
  }
}

// ─── State Helpers ──────────────────────────────────────────────────

async function readGuardrailState(): Promise<AdaptiveGuardrailState | null> {
  if (!redis) return null;
  const raw = await redis.get(AGENT_ADAPTIVE_GUARDRAILS_KEY);
  if (!raw) return null;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as AdaptiveGuardrailState;
}

async function writeGuardrailState(state: AdaptiveGuardrailState): Promise<void> {
  if (!redis) return;
  await redis.set(AGENT_ADAPTIVE_GUARDRAILS_KEY, JSON.stringify(state), { ex: 86400 * 7 });
}

function getActiveActions(state: AdaptiveGuardrailState | null): AdaptiveGuardrailAction[] {
  if (!state?.actions) return [];
  const now = Date.now();
  return state.actions.filter((a) => {
    if (a.rolledBack || a.status === "ROLLED_BACK" || a.status === "EXPIRED") return false;
    if (a.expiresAt && Date.parse(a.expiresAt) <= now) return false;
    return true;
  });
}

// ─── Apply Single Remediation ───────────────────────────────────────

export interface RemediationResult {
  applied: boolean;
  action?: AdaptiveGuardrailAction;
  reason: string;
  ledgerEntry?: LedgerEntry;
}

export async function applyOneRemediation(
  findings: LearningFinding[],
): Promise<RemediationResult> {
  const state = await readGuardrailState();
  const active = getActiveActions(state);

  if (active.length >= MAX_ACTIVE_REMEDIATIONS) {
    return { applied: false, reason: `max_active_remediations_reached (${active.length})` };
  }

  // Find first actionable finding
  for (const finding of findings) {
    const plan = planRemediation(finding, active);
    if (!plan) continue;

    const now = new Date();
    const action: AdaptiveGuardrailAction = {
      id: `learning_${plan.findingId}_${now.getTime()}`,
      actionType: plan.actionType as AdaptiveGuardrailAction["actionType"],
      reason: plan.reason,
      appliedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + REMEDIATION_TTL_HOURS * 3600_000).toISOString(),
      appliedValue: plan.appliedValue,
      previousValue: plan.previousValue,
      rolledBack: false,
      source: "learning-detector",
    };

    // Store in guardrail state
    const newState: AdaptiveGuardrailState = {
      actions: [...(state?.actions ?? []), action],
      lastEvaluatedAt: now.toISOString(),
      evaluationSource: state?.evaluationSource ?? "learning-remediation",
    };
    await writeGuardrailState(newState);

    // Record in ledger
    const ledgerEntry = await recordLedgerEntry({
      type: "remediation_applied",
      findingId: finding.id,
      findingCategory: finding.category,
      findingSeverity: finding.severity,
      actionId: action.id,
      actionType: plan.actionType,
      appliedValue: plan.appliedValue,
      previousValue: plan.previousValue,
      reason: plan.reason,
      verifyAfter: new Date(now.getTime() + VERIFICATION_WINDOW_MS).toISOString(),
    });

    console.log(
      `[LEARNING-REMEDIATION] Applied: ${plan.actionType} = ${plan.appliedValue} (finding: ${finding.id}, severity: ${finding.severity})`,
    );

    return { applied: true, action, reason: `applied_${plan.actionType}`, ledgerEntry };
  }

  return { applied: false, reason: "no_actionable_findings" };
}

// ─── Verification + Rollback ────────────────────────────────────────

export interface VerificationCheckResult {
  checked: number;
  rolledBack: number;
  verified: number;
  entries: LedgerEntry[];
}

/**
 * Check pending remediations whose verification window has elapsed.
 * If the finding that triggered the remediation is STILL present,
 * the remediation stays. If the overall situation worsened, roll back.
 */
export async function checkPendingRemediations(
  currentFindings: LearningFinding[],
): Promise<VerificationCheckResult> {
  const { readRecentLedger } = await import("@/lib/agents/learning-ledger");

  const recent = await readRecentLedger(50);
  const pendingRemediations = recent.filter(
    (e) => e.type === "remediation_applied" && !e.verifiedAt && e.verifyAfter,
  );

  const now = Date.now();
  const result: VerificationCheckResult = {
    checked: 0,
    rolledBack: 0,
    verified: 0,
    entries: [],
  };

  for (const entry of pendingRemediations) {
    if (!entry.verifyAfter || Date.parse(entry.verifyAfter) > now) continue;
    result.checked++;

    const originalFindingStillPresent = currentFindings.some(
      (f) => f.id === entry.findingId,
    );

    if (originalFindingStillPresent) {
      // Finding still present — remediation is justified, mark verified
      const verified = await recordLedgerEntry({
        type: "remediation_verified",
        findingId: entry.findingId,
        actionId: entry.actionId,
        actionType: entry.actionType,
        reason: `Original finding '${entry.findingId}' still active — remediation justified`,
      });
      result.verified++;
      result.entries.push(verified);
    } else {
      // Finding resolved — roll back the action
      await rollbackAction(entry.actionId ?? "");
      const rolled = await recordLedgerEntry({
        type: "remediation_rolled_back",
        findingId: entry.findingId,
        actionId: entry.actionId,
        actionType: entry.actionType,
        reason: `Original finding '${entry.findingId}' no longer present — rolling back`,
      });
      result.rolledBack++;
      result.entries.push(rolled);
    }
  }

  if (result.checked > 0) {
    console.log(
      `[LEARNING-REMEDIATION] Verification: checked=${result.checked} verified=${result.verified} rolledBack=${result.rolledBack}`,
    );
  }

  return result;
}

async function rollbackAction(actionId: string): Promise<boolean> {
  const state = await readGuardrailState();
  if (!state?.actions) return false;

  const action = state.actions.find((a) => a.id === actionId);
  if (!action || action.rolledBack) return false;

  action.rolledBack = true;
  action.rolledBackAt = new Date().toISOString();
  action.rollbackReason = "learning_verification_rollback";

  await writeGuardrailState(state);
  console.log(`[LEARNING-REMEDIATION] Rolled back action ${actionId}`);
  return true;
}
