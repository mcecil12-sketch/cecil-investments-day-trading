/**
 * GET /api/trades/protection-audit
 * Audits open trades for broker-truth stop protection integrity.
 * ?enforce=1 → attempt self-heal (repair missing stops, flatten on failure).
 */
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import { fetchBrokerTruth } from "@/lib/broker/truth";
import { saveCriticalTask } from "@/lib/redis";
import {
  auditProtectionIntegrity,
  envFlag,
  parseQty,
  type AuditResult,
  type BrokerPosition,
  type BrokerOrder,
} from "@/lib/risk/protection-integrity";
import {
  isOpenTradeStatus,
  normalizeTicker,
} from "@/lib/trades/protection";
import { createOrder } from "@/lib/alpaca";
import { forceFlattenPosition } from "@/lib/broker/forceFlattenPosition";
import { verifyStopAtBroker } from "@/lib/risk/stop-verification";

// ─── Enforce helpers ────────────────────────────────────────────────

/**
 * Place an emergency protective stop directly via the broker API.
 * Returns the order id on success.
 */
async function submitRepairStop(opts: {
  symbol: string;
  qty: number;
  side: "buy" | "sell";
  stopPrice: number;
}): Promise<{ ok: boolean; orderId?: string; error?: string }> {
  try {
    const order = await createOrder({
      symbol: opts.symbol,
      qty: String(opts.qty),
      side: opts.side,
      type: "stop",
      stop_price: String(opts.stopPrice),
      time_in_force: "gtc",
    });
    const id = String((order as any)?.id || "");
    if (!id) return { ok: false, error: "stop order returned without id" };
    return { ok: true, orderId: id };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ─── Enforce logic ──────────────────────────────────────────────────

async function enforceProtection(
  audit: AuditResult,
  brokerPositions: BrokerPosition[],
): Promise<{ repaired: string[]; flattened: string[]; failed: string[]; diagnostics: any[] }> {
  const repaired: string[] = [];
  const flattened: string[] = [];
  const failed: string[] = [];
  const diagnostics: any[] = [];

  const posBySymbol = new Map<string, BrokerPosition>();
  for (const p of brokerPositions) {
    const sym = normalizeTicker(p.symbol);
    if (sym) posBySymbol.set(sym, p);
  }

  for (const detail of audit.details) {
    const needsRepair = detail.incidents.some(
      (i) =>
        i.code === "MISSING_STOP" ||
        i.code === "STOP_EXPIRED" ||
        i.code === "STOP_CANCELED" ||
        i.code === "STOP_DAY_TIF",
    );
    if (!needsRepair) continue;

    const diag: Record<string, any> = {
      symbol: detail.symbol,
      stopRepairAttempted: false,
      stopRepairSucceeded: false,
      stopVerified: false,
      flattenAttempted: false,
      flattenSucceeded: false,
      cancelOrdersAttempted: false,
      cancelOrdersSucceeded: false,
      brokerPositionExistsAfter: null,
      finalResolution: "failed" as "protected" | "flattened" | "failed",
      stopRepairError: null as string | null,
    };

    const pos = posBySymbol.get(detail.symbol);
    if (!pos) {
      diag.stopRepairError = "no_broker_position";
      failed.push(detail.symbol);
      diagnostics.push(diag);
      continue;
    }
    const brokerQty = parseQty(pos.qty);
    if (brokerQty <= 0) {
      diag.stopRepairError = "zero_broker_qty";
      failed.push(detail.symbol);
      diagnostics.push(diag);
      continue;
    }

    const posSide =
      String(pos.side || "").toLowerCase() === "short" ? "short" : "long";
    const stopSide: "buy" | "sell" = posSide === "long" ? "sell" : "buy";
    const tradeSide: "LONG" | "SHORT" = posSide === "long" ? "LONG" : "SHORT";
    const entryPrice = Number(pos.avg_entry_price ?? 0);
    if (!entryPrice) {
      diag.stopRepairError = "missing_entry_price";
      failed.push(detail.symbol);
      diagnostics.push(diag);
      continue;
    }

    // Emergency stop at 2% from entry
    const stopPrice =
      posSide === "long"
        ? Math.round(entryPrice * 0.98 * 100) / 100
        : Math.round(entryPrice * 1.02 * 100) / 100;

    // ── A. Attempt stop repair directly via broker ──────────────────
    diag.stopRepairAttempted = true;
    const result = await submitRepairStop({
      symbol: detail.symbol,
      qty: brokerQty,
      side: stopSide,
      stopPrice,
    });

    if (result.ok && result.orderId) {
      // Verify the stop is actually active at broker before claiming success
      const verify = await verifyStopAtBroker({
        symbol: detail.symbol,
        side: tradeSide,
        stopOrderId: result.orderId,
      });
      if (verify.verified) {
        diag.stopRepairSucceeded = true;
        diag.stopVerified = true;
        diag.finalResolution = "protected";
        repaired.push(detail.symbol);
        console.log("[protection-audit] stop repair verified", {
          symbol: detail.symbol,
          qty: brokerQty,
          stopPrice,
          orderId: result.orderId,
        });
        diagnostics.push(diag);
        continue;
      }
      // Order created but not yet active — treat as repair failure
      diag.stopRepairError = `stop placed but not verified active (status=${verify.stopStatus ?? "unknown"})`;
    } else {
      diag.stopRepairError = result.error ?? "stop_order_failed";
    }

    // ── B. Repair failed → force flatten (cancels orders first) ────
    diag.flattenAttempted = true;
    console.error("[protection-audit] repair failed, force-flattening", {
      symbol: detail.symbol,
      error: diag.stopRepairError,
    });

    const flatResult = await forceFlattenPosition(detail.symbol);
    diag.cancelOrdersAttempted = flatResult.diagnostics.cancelOrdersAttempted;
    diag.cancelOrdersSucceeded = flatResult.diagnostics.cancelOrdersSucceeded;
    diag.flattenSucceeded = flatResult.ok;
    diag.brokerPositionExistsAfter = flatResult.diagnostics.brokerPositionExistsAfter;

    if (flatResult.ok) {
      diag.finalResolution = "flattened";
      flattened.push(detail.symbol);
      console.log("[protection-audit] force-flattened", { symbol: detail.symbol });
      await saveCriticalTask({
        incidentCode: "STOP_REPAIR_FAILED",
        symbol: detail.symbol,
        severity: "CRITICAL",
        detail: `Repair failed: ${diag.stopRepairError}; position force-flattened`,
      }).catch(() => {});
    } else {
      diag.finalResolution = "failed";
      diag.stopRepairError =
        (diag.stopRepairError ? diag.stopRepairError + "; " : "") +
        `flatten failed at step=${flatResult.step}: ${flatResult.error ?? "unknown"}`;
      failed.push(detail.symbol);
      console.error("[protection-audit] CRITICAL: force-flatten failed", {
        symbol: detail.symbol,
        step: flatResult.step,
        error: flatResult.error,
      });
      await saveCriticalTask({
        incidentCode: "FLATTEN_FAILED",
        symbol: detail.symbol,
        severity: "CRITICAL",
        detail: `Repair failed AND flatten failed: ${diag.stopRepairError}`,
      }).catch(() => {});
    }

    diagnostics.push(diag);
  }

  return { repaired, flattened, failed, diagnostics };
}

// ─── Route handler ──────────────────────────────────────────────────

export async function GET(req: Request) {
  const url = new URL(req.url);
  // Always enforce protection for live unprotected trades
  const enforce = true;

  const [rawTrades, brokerTruth] = await Promise.all([
    readTrades<Record<string, any>>().catch(() => []),
    fetchBrokerTruth(),
  ]);

  if (brokerTruth.error) {
    return NextResponse.json(
      { ok: false, error: "broker_truth_unavailable", detail: brokerTruth.error },
      { status: 502 },
    );
  }

  const positions: BrokerPosition[] = brokerTruth.positions || [];
  const orders: BrokerOrder[] = brokerTruth.openOrders || [];

  const allTrades = (Array.isArray(rawTrades) ? rawTrades : []) as Record<string, any>[];

  // ─── Broker-flat reconciliation ───────────────────────────────────
  // When broker has zero positions AND zero open orders, but DB still
  // has "open" trades, those trades are stale (e.g. manual exit completed
  // but DB wasn't updated). Auto-close them to prevent false CRITICAL
  // incidents. This preserves audit trail via closeReason.
  const brokerIsFlat =
    (!positions || positions.length === 0) &&
    (!orders || orders.length === 0);

  let reconciliation: { attempted: boolean; closedTickers: string[]; closedCount: number } = {
    attempted: false,
    closedTickers: [],
    closedCount: 0,
  };

  const dbOpenTrades = allTrades.filter((t) => isOpenTradeStatus(t?.status));

  if (brokerIsFlat && dbOpenTrades.length > 0) {
    reconciliation.attempted = true;
    const now = new Date().toISOString();
    const updatedTrades = allTrades.map((t) => {
      if (!isOpenTradeStatus(t?.status)) return t;
      const ticker = String(t.ticker || "").toUpperCase();
      reconciliation.closedTickers.push(ticker);
      reconciliation.closedCount++;
      console.log("[protection-audit] broker-flat reconciliation: closing stale DB trade", {
        id: t.id,
        ticker,
        previousStatus: t.status,
      });
      return {
        ...t,
        status: "CLOSED",
        closeReason: "broker_flat_reconciliation",
        closedAt: now,
        updatedAt: now,
        _reconciledAt: now,
        _reconciledBy: "protection-audit",
      };
    });

    try {
      await writeTrades(updatedTrades);
      console.log("[protection-audit] broker-flat reconciliation complete", {
        closedCount: reconciliation.closedCount,
        tickers: reconciliation.closedTickers,
      });
    } catch (err) {
      console.error("[protection-audit] broker-flat reconciliation write failed", err);
      reconciliation = { attempted: true, closedTickers: [], closedCount: 0 };
    }
  }

  // Re-read open trades after reconciliation
  const openTrades = (brokerIsFlat && reconciliation.closedCount > 0)
    ? [] // All were just closed
    : dbOpenTrades.map((t) => ({
      id: String(t.id || ""),
      ticker: String(t.ticker || ""),
      side: String(t.side || ""),
      status: String(t.status || ""),
      qty: Number(t.size || t.qty || 0),
      stopOrderId: t.stopOrderId || t.alpacaStopOrderId,
      protectionStatus: t.protectionStatus,
    }));

  const audit = auditProtectionIntegrity({
    openTrades,
    brokerPositions: positions,
    brokerOrders: orders,
  });

  // Only emit critical tasks for incidents that aren't stale reconciliation artifacts
  // When broker is flat and reconciliation just ran, skip critical task emission
  if (!reconciliation.attempted || reconciliation.closedCount === 0) {
    for (const incident of audit.incidents) {
      if (incident.severity === "CRITICAL") {
        await saveCriticalTask({
          incidentCode: incident.code,
          symbol: incident.symbol,
          severity: incident.severity,
          detail: incident.detail,
        }).catch((err) => {
          console.error("[protection-audit] saveCriticalTask failed", err);
        });
      }
    }
  }


  let enforcement:
    | { repaired: string[]; flattened: string[]; failed: string[] }
    | undefined;
  let observability: any = {};
  if (enforce && !audit.ok) {
    enforcement = await enforceProtection(audit, positions);
    const diagArr: any[] = (enforcement as any).diagnostics ?? [];
    observability = {
      unprotectedSymbols: audit.incidents.filter((i) => i.severity === "CRITICAL").map((i) => i.symbol),
      orphanBrokerPositions: audit.unmatchedBrokerPositions,
      protectionBlockerSymbols: audit.protectionBlockerSymbols,
      stopRepairAttempted: diagArr.some((d) => d.stopRepairAttempted),
      stopRepairSucceeded: enforcement.repaired.length > 0,
      flattenAttempted: diagArr.some((d) => d.flattenAttempted),
      flattenSucceeded: enforcement.flattened.length > 0,
      cancelOrdersAttempted: diagArr.some((d) => d.cancelOrdersAttempted),
      cancelOrdersSucceeded: diagArr.some((d) => d.cancelOrdersSucceeded),
      repairFailed: enforcement.failed.length > 0,
      repaired: enforcement.repaired,
      flattened: enforcement.flattened,
      failed: enforcement.failed,
      finalResolutions: diagArr.map((d) => ({ symbol: d.symbol, finalResolution: d.finalResolution })),
      details: diagArr,
    };
  }

  return NextResponse.json({
    ok: audit.ok,
    source: "broker-truth",
    brokerFetchedAt: brokerTruth.fetchedAt,
    auditedAt: audit.auditedAt,
    brokerIsFlat,
    // ── Broker-position coverage ──
    brokerPositionCount: audit.brokerPositionCount,
    matchedTradeCount: audit.matchedTradeCount,
    unmatchedBrokerPositions: audit.unmatchedBrokerPositions,
    unmatchedSymbols: audit.unmatchedBrokerPositions,
    protectedOrphanSymbols: audit.protectedOrphanSymbols,
    protectionBlockerSymbols: audit.protectionBlockerSymbols,
    // ── Counts ──
    openTrades: audit.tradeCount,
    protectedTrades: audit.protectedCount,
    unprotectedTrades: audit.tradeCount - audit.protectedCount + audit.unmatchedBrokerPositions.length,
    criticalCount: audit.criticalCount,
    incidentCount: audit.incidentCount,
    incidents: audit.incidents,
    details: audit.details,
    enforcement: enforcement || undefined,
    reconciliation: reconciliation.attempted ? reconciliation : undefined,
    observability,
  });
}
