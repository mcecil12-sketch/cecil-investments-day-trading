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
import { createOrder, alpacaRequest, normalizeAlpacaPrice } from "@/lib/alpaca";
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
}): Promise<{ ok: boolean; orderId?: string; submittedStopPrice?: number; error?: string }> {
  try {
    const submittedStopPrice = normalizeAlpacaPrice(Number(opts.stopPrice));
    const order = await createOrder({
      symbol: opts.symbol,
      qty: String(opts.qty),
      side: opts.side,
      type: "stop",
      stop_price: submittedStopPrice,
      time_in_force: "gtc",
    });
    const id = String((order as any)?.id || "");
    if (!id) return { ok: false, error: "stop order returned without id" };
    return { ok: true, orderId: id, submittedStopPrice };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonParseSafe(text: string): any {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return null;
  }
}

async function fetchSymbolOpenOrders(symbol: string): Promise<any[]> {
  const ordersResp = await alpacaRequest({
    method: "GET",
    path: `/v2/orders?status=open&symbols=${encodeURIComponent(symbol)}&limit=500`,
  });
  if (!ordersResp.ok) return [];
  const parsed = jsonParseSafe(ordersResp.text);
  return Array.isArray(parsed) ? parsed : [];
}

async function fetchPositionAvailability(symbol: string): Promise<{ qty: number; qtyAvailable: number | null; heldForOrders: number | null }> {
  const resp = await alpacaRequest({ method: "GET", path: `/v2/positions/${encodeURIComponent(symbol)}` });
  if (resp.status === 404) return { qty: 0, qtyAvailable: 0, heldForOrders: 0 };
  if (!resp.ok) return { qty: 0, qtyAvailable: null, heldForOrders: null };
  const pos = jsonParseSafe(resp.text) ?? {};
  const qty = Math.abs(Number(pos?.qty ?? 0));
  const qtyAvailableRaw = pos?.qty_available ?? pos?.available ?? null;
  const qtyAvailable = qtyAvailableRaw == null ? null : Math.abs(Number(qtyAvailableRaw));
  const heldForOrders = qtyAvailable != null && Number.isFinite(qtyAvailable) ? Math.max(0, qty - qtyAvailable) : null;
  return { qty, qtyAvailable, heldForOrders };
}

// ─── Enforce logic ──────────────────────────────────────────────────

/**
 * Cancel all open exit-side orders for a symbol at broker and wait until
 * held_for_orders pressure is cleared.
 */
async function cancelExitOrdersAndWait(
  symbol: string,
  closeSide: "buy" | "sell",
): Promise<{ canceled: number; attempted: number; remainingOpen: number; heldForOrders: number | null; qtyAvailable: number | null; error: string | null }> {
  try {
    const openOrders = await fetchSymbolOpenOrders(symbol);
    const conflicting = openOrders.filter((o) => String(o?.side || "").toLowerCase() === closeSide);
    let canceled = 0;
    for (const order of conflicting) {
      if (!order?.id) continue;
      try {
        await alpacaRequest({ method: "DELETE", path: `/v2/orders/${encodeURIComponent(String(order.id))}` });
        canceled++;
      } catch {
        // best-effort
      }
    }

    let remainingOpen = 0;
    let heldForOrders: number | null = null;
    let qtyAvailable: number | null = null;
    for (let i = 0; i < 8; i++) {
      await sleep(350);
      const [ordersNow, posNow] = await Promise.all([
        fetchSymbolOpenOrders(symbol),
        fetchPositionAvailability(symbol),
      ]);
      remainingOpen = ordersNow.filter((o) => String(o?.side || "").toLowerCase() === closeSide).length;
      heldForOrders = posNow.heldForOrders;
      qtyAvailable = posNow.qtyAvailable;
      if (remainingOpen === 0 && (heldForOrders == null || heldForOrders <= 0)) break;
    }

    return { canceled, attempted: conflicting.length, remainingOpen, heldForOrders, qtyAvailable, error: null };
  } catch (err: any) {
    return { canceled: 0, attempted: 0, remainingOpen: 0, heldForOrders: null, qtyAvailable: null, error: err?.message ?? String(err) };
  }
}

async function readOrderStatus(orderId: string): Promise<{ status: string | null; cancelReason: string | null }> {
  const resp = await alpacaRequest({ method: "GET", path: `/v2/orders/${encodeURIComponent(orderId)}` });
  if (!resp.ok) return { status: null, cancelReason: null };
  const ord = jsonParseSafe(resp.text) ?? {};
  const status = String(ord?.status || "").toLowerCase() || null;
  const cancelReason = String(ord?.cancel_reason ?? ord?.rejected_reason ?? ord?.failed_at ?? "") || null;
  return { status, cancelReason };
}

async function enforceProtection(
  audit: AuditResult,
  brokerPositions: BrokerPosition[],
  brokerOrders: BrokerOrder[],
  openTradeBySymbol: Map<string, Record<string, any>>,
): Promise<{ repaired: string[]; flattened: string[]; failed: string[]; diagnostics: any[]; tradeUpdates: Array<{ tradeId: string; patch: Record<string, any> }> }> {
  const repaired: string[] = [];
  const flattened: string[] = [];
  const failed: string[] = [];
  const diagnostics: any[] = [];
  const tradeUpdates: Array<{ tradeId: string; patch: Record<string, any> }> = [];

  const posBySymbol = new Map<string, BrokerPosition>();
  for (const p of brokerPositions) {
    const sym = normalizeTicker(p.symbol);
    if (sym) posBySymbol.set(sym, p);
  }

  // Index open orders by symbol for stale-order detection
  const ordersBySymbol = new Map<string, BrokerOrder[]>();
  for (const o of brokerOrders) {
    const sym = normalizeTicker(o.symbol);
    if (!sym) continue;
    const bucket = ordersBySymbol.get(sym) ?? [];
    bucket.push(o);
    ordersBySymbol.set(sym, bucket);
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

    // ── Derive stale tracked stop order id ──────────────────────────
    // The incident detail carries the tracked stopOrderId when present.
    const missingStopIncident = detail.incidents.find((i) => i.code === "MISSING_STOP");
    const staleTrackedStopOrderId: string | null = (() => {
      if (!missingStopIncident) return null;
      const m = missingStopIncident.detail.match(/tracked stopOrderId=(\S+)/);
      return m ? m[1] : null;
    })();

    const symbolOrders = ordersBySymbol.get(detail.symbol) ?? [];
    const activeBrokerStopFound = symbolOrders.some(
      (o) =>
        (o.type === "stop" || o.type === "stop_limit") &&
        (o.status === "accepted" || o.status === "new" || o.status === "held"),
    );

    const diag: Record<string, any> = {
      symbol: detail.symbol,
      tradeId: openTradeBySymbol.get(detail.symbol)?.id ?? null,
      // ── Enhanced Workflow v2 diagnostics ────────
      staleTrackedStopOrderId,
      activeBrokerStopFound,
      stopRepairRetryAttempted: false,
      stopRepairFinalStatus: "failed" as "protected" | "flattened" | "failed",
      submittedStopPrice: null as number | null,
      // ── Legacy diagnostics (preserved for backward compat) ─────────
      stopRepairAttempted: false,
      stopRepairSucceeded: false,
      stopVerified: false,
      flattenAttempted: false,
      flattenSucceeded: false,
      cancelOrdersAttempted: false,
      cancelOrdersSucceeded: false,
      canceledOrderCount: 0,
      brokerPositionExistsAfter: null,
      finalResolution: "failed" as "protected" | "flattened" | "failed",
      stopRepairError: null as string | null,
      cancelReason: null as string | null,
      heldForOrders: null as number | null,
      qtyAvailable: null as number | null,
    };

    const openTrade = openTradeBySymbol.get(detail.symbol) ?? null;

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

    // Broker truth must win for canonical trade basis.
    if (openTrade?.id) {
      const fillPatch: Record<string, any> = {
        entryPrice,
        entryFillPrice: entryPrice,
        filledQty: brokerQty,
        brokerSyncedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      tradeUpdates.push({ tradeId: openTrade.id, patch: fillPatch });
    }

    // Recalculate stop only when no valid persisted stop exists; otherwise use persisted plan stop.
    const persistedStop = Number(openTrade?.stopPrice ?? 0);
    const stopPrice = persistedStop > 0
      ? persistedStop
      : (posSide === "long"
          ? Math.round(entryPrice * 0.98 * 100) / 100
          : Math.round(entryPrice * 1.02 * 100) / 100);

    // ── Pre-repair: cancel conflicting same-side orders to free qty ──
    // Stale sell limit orders hold qty and prevent stop placement for longs.
    diag.cancelOrdersAttempted = true;
    const cancelResult = await cancelExitOrdersAndWait(detail.symbol, stopSide);
    diag.cancelOrdersSucceeded = cancelResult.error === null && cancelResult.remainingOpen === 0;
    diag.canceledOrderCount = cancelResult.canceled;
    diag.heldForOrders = cancelResult.heldForOrders;
    diag.qtyAvailable = cancelResult.qtyAvailable;
    if (cancelResult.error) {
      console.warn("[protection-audit] pre-repair cancel failed (non-fatal)", {
        symbol: detail.symbol, error: cancelResult.error,
      });
    }

    // ── A. Attempt stop repair directly via broker ──────────────────
    diag.stopRepairAttempted = true;
    const result = await submitRepairStop({
      symbol: detail.symbol,
      qty: brokerQty,
      side: stopSide,
      stopPrice,
    });

    if (result.ok && result.orderId) {
      diag.submittedStopPrice = Number(result.submittedStopPrice ?? stopPrice);
      const orderState = await readOrderStatus(result.orderId);
      if (orderState.status === "canceled" || orderState.status === "cancelled" || orderState.status === "rejected" || orderState.status === "expired") {
        diag.cancelReason = orderState.cancelReason;
        diag.stopRepairError = `stop_immediately_${orderState.status}${orderState.cancelReason ? `:${orderState.cancelReason}` : ""}`;
      }
      // Verify the stop is actually active at broker before claiming success
      const verify = await verifyStopAtBroker({
        symbol: detail.symbol,
        side: tradeSide,
        stopOrderId: result.orderId,
        expectedStopPrice: result.submittedStopPrice ?? stopPrice,
      });
      if (verify.verified) {
        diag.stopRepairSucceeded = true;
        diag.stopVerified = true;
        diag.finalResolution = "protected";
        diag.stopRepairFinalStatus = "protected";
        repaired.push(detail.symbol);
        if (openTrade?.id) {
          tradeUpdates.push({
            tradeId: openTrade.id,
            patch: {
              stopOrderId: result.orderId,
              protectionStatus: "VERIFIED",
              protectionIssue: null,
              protectionVerifiedAt: new Date().toISOString(),
              brokerSyncedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          });
        }
        console.log("[protection-audit] stop repair verified", {
          symbol: detail.symbol,
          qty: brokerQty,
          stopPrice: result.submittedStopPrice ?? stopPrice,
          orderId: result.orderId,
        });
        diagnostics.push(diag);
        continue;
      }
      // Order created but not yet active — treat as repair failure
      diag.stopRepairError = diag.stopRepairError ?? `stop placed but not verified active (status=${verify.stopStatus ?? "unknown"})`;
    } else {
      diag.stopRepairError = result.error ?? "stop_order_failed";
    }

    // ── B. Retry: cancel ALL conflicting orders and retry stop once ─
    // Only retry if we haven't already canceled orders, and there are open orders.
    // Always retry once after ensuring held quantity/open exits are cleared.
    diag.stopRepairRetryAttempted = true;
    const retryCancelResult = await cancelExitOrdersAndWait(detail.symbol, stopSide);
    diag.cancelOrdersAttempted = true;
    diag.cancelOrdersSucceeded = retryCancelResult.error === null && retryCancelResult.remainingOpen === 0;
    diag.canceledOrderCount = (diag.canceledOrderCount as number) + retryCancelResult.canceled;
    diag.heldForOrders = retryCancelResult.heldForOrders;
    diag.qtyAvailable = retryCancelResult.qtyAvailable;

    const retryResult = await submitRepairStop({ symbol: detail.symbol, qty: brokerQty, side: stopSide, stopPrice });
    if (retryResult.ok && retryResult.orderId) {
      diag.submittedStopPrice = Number(retryResult.submittedStopPrice ?? stopPrice);
      const retryOrderState = await readOrderStatus(retryResult.orderId);
      if (retryOrderState.status === "canceled" || retryOrderState.status === "cancelled" || retryOrderState.status === "rejected" || retryOrderState.status === "expired") {
        diag.cancelReason = retryOrderState.cancelReason;
      }
      const retryVerify = await verifyStopAtBroker({
        symbol: detail.symbol,
        side: tradeSide,
        stopOrderId: retryResult.orderId,
        expectedStopPrice: retryResult.submittedStopPrice ?? stopPrice,
      });
      if (retryVerify.verified) {
        diag.stopRepairSucceeded = true;
        diag.stopVerified = true;
        diag.finalResolution = "protected";
        diag.stopRepairFinalStatus = "protected";
        diag.stopRepairError = null;
        repaired.push(detail.symbol);
        if (openTrade?.id) {
          tradeUpdates.push({
            tradeId: openTrade.id,
            patch: {
              stopOrderId: retryResult.orderId,
              protectionStatus: "VERIFIED",
              protectionIssue: null,
              protectionVerifiedAt: new Date().toISOString(),
              brokerSyncedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          });
        }
        console.log("[protection-audit] stop repair verified on retry", {
          symbol: detail.symbol,
          qty: brokerQty,
          stopPrice: retryResult.submittedStopPrice ?? stopPrice,
          orderId: retryResult.orderId,
        });
        diagnostics.push(diag);
        continue;
      }
      diag.stopRepairError = `retry: stop placed but not verified (status=${retryVerify.stopStatus ?? "unknown"})`;
    } else {
      diag.stopRepairError = `retry: ${retryResult.error ?? "stop_order_failed"}`;
    }

    // ── C. Repair failed → force flatten (cancels orders first) ────
    diag.flattenAttempted = true;
    console.error("[protection-audit] repair failed, force-flattening", {
      symbol: detail.symbol,
      error: diag.stopRepairError,
    });

    const flatResult = await forceFlattenPosition(detail.symbol);
    if (!diag.cancelOrdersAttempted) {
      diag.cancelOrdersAttempted = flatResult.diagnostics.cancelOrdersAttempted;
      diag.cancelOrdersSucceeded = flatResult.diagnostics.cancelOrdersSucceeded;
    }
    diag.flattenSucceeded = flatResult.ok;
    diag.brokerPositionExistsAfter = flatResult.diagnostics.brokerPositionExistsAfter;

    if (flatResult.ok) {
      diag.finalResolution = "flattened";
      diag.stopRepairFinalStatus = "flattened";
      flattened.push(detail.symbol);
      if (openTrade?.id) {
        tradeUpdates.push({
          tradeId: openTrade.id,
          patch: {
            stopOrderId: null,
            protectionStatus: "FLATTENED",
            protectionIssue: "repair_failed_position_flattened",
            brokerSyncedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        });
      }
      console.log("[protection-audit] force-flattened", { symbol: detail.symbol });
      await saveCriticalTask({
        incidentCode: "STOP_REPAIR_FAILED",
        symbol: detail.symbol,
        severity: "CRITICAL",
        detail: `Repair failed: ${diag.stopRepairError}; position force-flattened`,
      }).catch(() => {});
    } else {
      diag.finalResolution = "failed";
      diag.stopRepairFinalStatus = "failed";
      diag.stopRepairError =
        (diag.stopRepairError ? diag.stopRepairError + "; " : "") +
        `flatten failed at step=${flatResult.step}: ${flatResult.error ?? "unknown"}`;
      failed.push(detail.symbol);
      if (openTrade?.id) {
        tradeUpdates.push({
          tradeId: openTrade.id,
          patch: {
            stopOrderId: null,
            protectionStatus: "FLATTEN_FAILED",
            protectionIssue: diag.stopRepairError,
            brokerSyncedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        });
      }
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

  return { repaired, flattened, failed, diagnostics, tradeUpdates };
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
      entryPrice: Number(t.entryPrice || 0),
      stopPrice: Number(t.stopPrice || 0),
      filledQty: Number(t.filledQty || t.size || t.qty || 0),
      stopOrderId: t.stopOrderId || t.alpacaStopOrderId,
      protectionStatus: t.protectionStatus,
    }));

  const openTradeBySymbol = new Map<string, Record<string, any>>();
  const sortedDbOpenTrades = [...dbOpenTrades].sort((a, b) => {
    const aTs = Date.parse(String(a.updatedAt || a.createdAt || "")) || 0;
    const bTs = Date.parse(String(b.updatedAt || b.createdAt || "")) || 0;
    return bTs - aTs;
  });
  for (const t of sortedDbOpenTrades) {
    const sym = normalizeTicker(t.ticker);
    if (!sym || openTradeBySymbol.has(sym)) continue;
    openTradeBySymbol.set(sym, t);
  }

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
  let finalAudit = audit;
  if (enforce && !audit.ok) {
    const enforcementResult = await enforceProtection(audit, positions, orders, openTradeBySymbol);
    enforcement = enforcementResult;
    if (enforcementResult.tradeUpdates.length > 0) {
      const now = new Date().toISOString();
      const byTradeId = new Map<string, Record<string, any>>();
      for (const u of enforcementResult.tradeUpdates) {
        const prev = byTradeId.get(u.tradeId) ?? {};
        byTradeId.set(u.tradeId, { ...prev, ...u.patch, updatedAt: now });
      }
      const merged = allTrades.map((t) => {
        const patch = byTradeId.get(String(t.id || ""));
        if (!patch) return t;
        return { ...t, ...patch };
      });
      await writeTrades(merged).catch((err) => {
        console.error("[protection-audit] failed to persist enforcement trade updates", err);
      });
    }
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
      // ── Workflow v2 diagnostics ───────────────────────────────────
      stopRepairRetryAttempted: diagArr.some((d) => d.stopRepairRetryAttempted),
      activeBrokerStopFound: diagArr.some((d) => d.activeBrokerStopFound),
      staleTrackedStopOrderIds: diagArr
        .filter((d) => d.staleTrackedStopOrderId)
        .map((d) => ({ symbol: d.symbol, staleTrackedStopOrderId: d.staleTrackedStopOrderId })),
      stopRepairFinalStatuses: diagArr.map((d) => ({
        symbol: d.symbol,
        stopRepairFinalStatus: d.stopRepairFinalStatus,
      })),
      finalResolutions: diagArr.map((d) => ({ symbol: d.symbol, finalResolution: d.finalResolution })),
      details: diagArr,
    };

    try {
      const postTruth = await fetchBrokerTruth({ forceRefresh: true });
      if (!postTruth.error) {
        const postTrades = await readTrades<Record<string, any>>().catch(() => []);
        const postOpenTrades = (Array.isArray(postTrades) ? postTrades : [])
          .filter((t) => isOpenTradeStatus(t?.status))
          .map((t) => ({
            id: String(t.id || ""),
            ticker: String(t.ticker || ""),
            side: String(t.side || ""),
            status: String(t.status || ""),
            qty: Number(t.size || t.qty || 0),
            stopOrderId: t.stopOrderId || t.alpacaStopOrderId,
            protectionStatus: t.protectionStatus,
          }));
        finalAudit = auditProtectionIntegrity({
          openTrades: postOpenTrades,
          brokerPositions: postTruth.positions || [],
          brokerOrders: postTruth.openOrders || [],
        });
      }
    } catch {
      // fallback to pre-enforcement audit
    }
  }

  return NextResponse.json({
    ok: brokerIsFlat ? true : finalAudit.ok,
    source: "broker-truth",
    brokerFetchedAt: brokerTruth.fetchedAt,
    auditedAt: finalAudit.auditedAt,
    brokerIsFlat,
    // ── Broker-position coverage ──
    brokerPositionCount: finalAudit.brokerPositionCount,
    matchedTradeCount: finalAudit.matchedTradeCount,
    unmatchedBrokerPositions: finalAudit.unmatchedBrokerPositions,
    unmatchedSymbols: finalAudit.unmatchedBrokerPositions,
    protectedOrphanSymbols: finalAudit.protectedOrphanSymbols,
    protectionBlockerSymbols: finalAudit.protectionBlockerSymbols,
    // ── Counts ──
    openTrades: finalAudit.tradeCount,
    protectedTrades: finalAudit.protectedCount,
    unprotectedTrades: finalAudit.tradeCount - finalAudit.protectedCount + finalAudit.unmatchedBrokerPositions.length,
    criticalCount: finalAudit.criticalCount,
    incidentCount: finalAudit.incidentCount,
    incidents: finalAudit.incidents,
    details: finalAudit.details,
    enforcement: enforcement || undefined,
    reconciliation: reconciliation.attempted ? reconciliation : undefined,
    observability,
  });
}
