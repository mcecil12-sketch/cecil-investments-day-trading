/**
 * GET  /api/agents/adaptive-guardrails — Active adaptive actions, why triggered, when they expire
 * POST /api/agents/adaptive-guardrails — Trigger evaluation or rollback a specific action
 *
 * Surfaces the adaptive guardrail layer for observability.
 */
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { checkAgentCronAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import {
  readAdaptiveGuardrailState,
  getActiveActions,
  evaluateAdaptiveGuardrails,
  rollbackAction,
} from "@/lib/agents/adaptiveGuardrails";

export async function GET(req: Request) {
  const auth = checkAgentCronAuth(req);
  if (!auth.ok) return unauthorizedAgentResponse(auth.error);

  const state = await readAdaptiveGuardrailState();
  const active = getActiveActions(state);

  return NextResponse.json({
    ok: true,
    lastEvaluatedAt: state.lastEvaluatedAt,
    evaluationSource: state.evaluationSource,
    activeActionCount: active.length,
    activeActions: active.map((a) => ({
      id: a.id,
      actionType: a.actionType,
      reason: a.reason,
      triggerPattern: a.triggerPattern,
      appliedAt: a.appliedAt,
      expiresAt: a.expiresAt,
      appliedValue: a.appliedValue,
      previousValue: a.previousValue,
    })),
    totalHistoricalActions: state.actions.length,
    recentActions: state.actions.slice(-10).map((a) => ({
      id: a.id,
      actionType: a.actionType,
      status: a.status,
      triggerPattern: a.triggerPattern,
      appliedAt: a.appliedAt,
      expiresAt: a.expiresAt,
      rolledBackAt: a.rolledBackAt,
    })),
  });
}

export async function POST(req: NextRequest) {
  const auth = checkAgentCronAuth(req);
  if (!auth.ok) return unauthorizedAgentResponse(auth.error);

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  // POST ?action=rollback&id=<actionId>
  if (action === "rollback") {
    const actionId = url.searchParams.get("id");
    if (!actionId) {
      return NextResponse.json({ ok: false, error: "missing id param" }, { status: 400 });
    }
    const rolled = await rollbackAction(actionId);
    return NextResponse.json({ ok: rolled, rolledBack: rolled, actionId });
  }

  // POST ?action=evaluate — trigger fresh evaluation
  if (action === "evaluate" || !action) {
    const result = await evaluateAdaptiveGuardrails();
    return NextResponse.json({
      ok: true,
      evaluated: result.evaluated,
      actionsApplied: result.actionsApplied.length,
      actionsAppliedDetails: result.actionsApplied.map((a) => ({
        id: a.id,
        actionType: a.actionType,
        reason: a.reason,
        expiresAt: a.expiresAt,
      })),
      tasksCreated: result.tasksCreated,
      expiredActions: result.expiredActions,
      activeActionCount: result.activeActions.length,
      activeActions: result.activeActions.map((a) => ({
        id: a.id,
        actionType: a.actionType,
        reason: a.reason,
        expiresAt: a.expiresAt,
      })),
      signalsSummary: result.signals
        ? {
            totalTrades: result.signals.totalTrades,
            winRate: result.signals.winRate,
            avgR: result.signals.avgR,
            deepLossRate: result.signals.deepLossRate,
            longWinRate: result.signals.longWinRate,
            shortWinRate: result.signals.shortWinRate,
          }
        : null,
    });
  }

  return NextResponse.json({ ok: false, error: `unknown action: ${action}` }, { status: 400 });
}
