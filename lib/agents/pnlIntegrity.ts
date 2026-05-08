/**
 * PnL Integrity Validation
 *
 * Validates realized PnL against Alpaca broker fills for all recent closed trades.
 * If mismatches exceed tolerance, flags systemState.pnlIntegrity = false and
 * creates a CRITICAL engineering task to fix the root cause.
 */

import { redis } from "@/lib/redis";
import { getTtlSeconds } from "@/lib/redis/ttl";
import { alpacaRequest } from "@/lib/alpaca";
import { detectRAnomalies, type RAnomalyResult } from "@/lib/agents/performanceLearning";
import { appendEngineeringTask } from "@/lib/agents/store";
import { nowIso } from "@/lib/agents/time";
import type { EngineeringTask } from "@/lib/agents/types";

import { AGENT_PNL_INTEGRITY_KEY } from "@/lib/agents/keys";
const STORE_TTL = getTtlSeconds("TELEMETRY_DAYS");

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PnlMismatchResult {
  type: "PNL_MISMATCH";
  severity: "CRITICAL";
  tradeId: string;
  symbol: string;
  appPnL: number;
  brokerPnL: number;
}

export type IntegrityIssue = RAnomalyResult | PnlMismatchResult;

export interface PnlIntegrityState {
  checkedAt: string;
  pnlIntegrity: boolean;
  issueCount: number;
  issues: IntegrityIssue[];
  taskCreated: boolean;
  taskId: string | null;
}

// ─── Alpaca Fill Fetcher ──────────────────────────────────────────────────────

async function fetchFillsForOrder(orderId: string): Promise<Array<{ qty: string; price: string; side: string }>> {
  try {
    const qs = new URLSearchParams({
      activity_types: "FILL",
      order_id: orderId,
      page_size: "100",
      direction: "desc",
    });
    const resp = await alpacaRequest({ method: "GET", path: `/v2/account/activities?${qs.toString()}` });
    if (!resp.ok) return [];
    const arr = JSON.parse(resp.text || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// ─── PnL Validation ───────────────────────────────────────────────────────────

interface TradeLike {
  id?: string;
  symbol?: string;
  ticker?: string;
  side?: string;
  brokerOrderId?: string;
  exitOrderId?: string;
  stopOrderId?: string;
  takeProfitOrderId?: string;
  realizedPnL?: number | null;
  realizedR?: number | null;
  entryFillPrice?: number | null;
  exitFillPrice?: number | null;
  entryPrice?: number | null;
  qty?: number | null;
  filledQty?: number | null;
}

export async function validatePnLIntegrity(trades: TradeLike[]): Promise<PnlMismatchResult[]> {
  const mismatches: PnlMismatchResult[] = [];

  for (const t of trades) {
    // Require an explicit exit order ID — brokerOrderId is the ENTRY order and would give wrong fills.
    const exitOrderId = String(t.exitOrderId || "").trim();
    if (!exitOrderId) continue;
    if (t.realizedPnL === null || t.realizedPnL === undefined) continue;

    const fills = await fetchFillsForOrder(exitOrderId);
    if (!fills.length) continue;

    const toNum = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

    let notional = 0;
    let totalQty = 0;
    for (const f of fills) {
      const px = toNum(f.price);
      const q = Math.abs(toNum(f.qty) ?? 0);
      if (px == null || px <= 0 || q <= 0) continue;
      notional += px * q;
      totalQty += q;
    }

    if (totalQty <= 0) continue;

    const avgExitFill = notional / totalQty;
    const entryRef = toNum(t.entryFillPrice ?? t.entryPrice);
    if (entryRef === null) continue;

    const qty = toNum(t.filledQty ?? t.qty) ?? totalQty;
    // Side-aware PnL estimation: LONG = (exitFill - entry) * qty; SHORT = (entry - exitFill) * qty
    const side = String(t.side || "LONG").toUpperCase();
    const estimatedPnL = side === "SHORT"
      ? (entryRef - avgExitFill) * qty
      : (avgExitFill - entryRef) * qty;

    // Tighten threshold: 5% of trade value or $25 min (was a flat $500 which misses small accounts)
    const threshold = Math.max(25, Math.abs(t.realizedPnL) * 0.05);
    if (Math.abs(estimatedPnL - t.realizedPnL) > threshold) {
      mismatches.push({
        type: "PNL_MISMATCH",
        severity: "CRITICAL",
        tradeId: t.id ?? "unknown",
        symbol: t.symbol ?? t.ticker ?? "unknown",
        appPnL: t.realizedPnL,
        brokerPnL: estimatedPnL,
      });
    }
  }

  return mismatches;
}

// ─── Integrity Task Creator ───────────────────────────────────────────────────

async function createIntegrityTask(issues: IntegrityIssue[]): Promise<string | null> {
  try {
    const task: EngineeringTask = {
      id: `pnl-integrity-${Date.now().toString(36)}`,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      status: "OPEN",
      title: "CRITICAL: PnL / R calculation integrity failure",
      summary: `${issues.length} integrity issue(s) detected. Fix PnL and R calculations using Alpaca fills as source of truth.`,
      likelyFiles: [
        "lib/maintenance/reconcileOpenTrades.ts",
        "app/api/trades/manage/route.ts",
        "lib/trades/finalizeClose.ts",
      ],
      copilotPrompt: `CRITICAL integrity failure detected. Issues: ${JSON.stringify(issues.slice(0, 5))}. Use Alpaca fill activities as sole source of truth for realizedPnL and realizedR. Fix weighted-average fill aggregation.`,
      smokeTestBlock: "GET /api/agents/state\nGET /api/readiness",
      gitBlock: "agent: fix PnL integrity using Alpaca fills",
      patchPlan: {
        mode: "GITHUB_COMMIT",
        targetFiles: [
          "lib/maintenance/reconcileOpenTrades.ts",
          "app/api/trades/manage/route.ts",
        ],
        proposedChangesSummary: "Use Alpaca fill activity aggregation as sole source of truth for realized PnL and R calculations.",
      },
      commitPlan: {
        commitMessage: "agent: fix PnL/R integrity — use Alpaca fills as source of truth",
        targetBranch: "main",
        pushDirect: true,
      },
      validationPlan: {
        buildRequired: true,
        testCommands: ["npm run test"],
        smokeChecks: ["GET /api/agents/state", "GET /api/readiness"],
      },
    };
    const saved = await appendEngineeringTask(task).catch(() => null);
    return saved?.id ?? null;
  } catch {
    return null;
  }
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export async function runPnlIntegrityCheck(trades: TradeLike[]): Promise<PnlIntegrityState> {
  const rAnomalies = detectRAnomalies(trades);

  let pnlMismatches: PnlMismatchResult[] = [];
  try {
    pnlMismatches = await validatePnLIntegrity(trades);
  } catch (e) {
    console.warn("[pnl-integrity] PnL validation skipped:", e);
  }

  const integrityIssues: IntegrityIssue[] = [...rAnomalies, ...pnlMismatches];
  const pnlIntegrity = integrityIssues.length === 0;

  if (!pnlIntegrity) {
    console.error("[pnl-integrity] PnL INTEGRITY FAILURE", integrityIssues);
  }

  let taskId: string | null = null;
  let taskCreated = false;

  if (!pnlIntegrity) {
    taskId = await createIntegrityTask(integrityIssues).catch(() => null);
    taskCreated = !!taskId;
  }

  const state: PnlIntegrityState = {
    checkedAt: nowIso(),
    pnlIntegrity,
    issueCount: integrityIssues.length,
    issues: integrityIssues,
    taskCreated,
    taskId,
  };

  // Persist
  if (redis) {
    try {
      await redis.set(AGENT_PNL_INTEGRITY_KEY, JSON.stringify(state), { ex: STORE_TTL });
    } catch {
      // non-fatal
    }
  }

  return state;
}

export async function readPnlIntegrityState(): Promise<PnlIntegrityState | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get<string>(AGENT_PNL_INTEGRITY_KEY);
    if (!raw) return null;
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === "object" && "pnlIntegrity" in parsed) {
      return parsed as PnlIntegrityState;
    }
    return null;
  } catch {
    return null;
  }
}
