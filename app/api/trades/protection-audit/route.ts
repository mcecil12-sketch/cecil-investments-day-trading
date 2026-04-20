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
import { alpacaHeaders, tradingUrl } from "@/lib/alpaca";

// ─── Enforce helpers ────────────────────────────────────────────────

async function submitRepairStop(opts: {
  symbol: string;
  qty: number;
  side: "buy" | "sell";
  stopPrice: number;
}): Promise<{ ok: boolean; orderId?: string; error?: string }> {
  try {
    const resp = await fetch(tradingUrl("/v2/orders"), {
      method: "POST",
      headers: { ...alpacaHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: opts.symbol,
        qty: String(opts.qty),
        side: opts.side,
        type: "stop",
        stop_price: String(opts.stopPrice),
        time_in_force: "gtc",
      }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, error: `${resp.status}: ${text}` };
    }
    const order = await resp.json();
    return { ok: true, orderId: order.id };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function flattenPosition(
  symbol: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await fetch(
      tradingUrl(`/v2/positions/${encodeURIComponent(symbol)}`),
      { method: "DELETE", headers: alpacaHeaders() },
    );
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, error: `${resp.status}: ${text}` };
    }
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// ─── Enforce logic ──────────────────────────────────────────────────

async function enforceProtection(
  audit: AuditResult,
  brokerPositions: BrokerPosition[],
): Promise<{ repaired: string[]; flattened: string[]; failed: string[] }> {
  const repaired: string[] = [];
  const flattened: string[] = [];
  const failed: string[] = [];

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

    const pos = posBySymbol.get(detail.symbol);
    if (!pos) {
      failed.push(detail.symbol);
      continue;
    }
    const brokerQty = parseQty(pos.qty);
    if (brokerQty <= 0) {
      failed.push(detail.symbol);
      continue;
    }

    const posSide =
      String(pos.side || "").toLowerCase() === "short" ? "short" : "long";
    const stopSide: "buy" | "sell" = posSide === "long" ? "sell" : "buy";
    const entryPrice = Number(pos.avg_entry_price ?? 0);
    if (!entryPrice) {
      failed.push(detail.symbol);
      continue;
    }

    // Emergency stop at 2% from entry
    const stopPrice =
      posSide === "long"
        ? Math.round(entryPrice * 0.98 * 100) / 100
        : Math.round(entryPrice * 1.02 * 100) / 100;

    const result = await submitRepairStop({
      symbol: detail.symbol,
      qty: brokerQty,
      side: stopSide,
      stopPrice,
    });

    if (result.ok) {
      repaired.push(detail.symbol);
      console.log("[protection-audit] repaired stop", {
        symbol: detail.symbol,
        qty: brokerQty,
        stopPrice,
        orderId: result.orderId,
      });
    } else {
      // Flatten on repair fail (gated by env flag)
      if (envFlag("RISK_FLATTEN_ON_REPAIR_FAIL")) {
        console.error("[protection-audit] repair failed, flattening", {
          symbol: detail.symbol,
          error: result.error,
        });
        const flatResult = await flattenPosition(detail.symbol);
        if (flatResult.ok) {
          flattened.push(detail.symbol);
          console.log("[protection-audit] flattened", { symbol: detail.symbol });
          await saveCriticalTask({
            incidentCode: "STOP_REPAIR_FAILED",
            symbol: detail.symbol,
            severity: "CRITICAL",
            detail: `Repair failed: ${result.error}; position flattened`,
          }).catch(() => {});
        } else {
          failed.push(detail.symbol);
          console.error("[protection-audit] flatten failed", {
            symbol: detail.symbol,
            error: flatResult.error,
          });
          await saveCriticalTask({
            incidentCode: "FLATTEN_FAILED",
            symbol: detail.symbol,
            severity: "CRITICAL",
            detail: `Repair failed: ${result.error}; flatten also failed: ${flatResult.error}`,
          }).catch(() => {});
        }
      } else {
        failed.push(detail.symbol);
        console.error("[protection-audit] repair failed (flatten disabled)", {
          symbol: detail.symbol,
          error: result.error,
        });
        await saveCriticalTask({
          incidentCode: "STOP_REPAIR_FAILED",
          symbol: detail.symbol,
          severity: "CRITICAL",
          detail: `Repair failed: ${result.error}; flatten disabled`,
        }).catch(() => {});
      }
    }
  }

  return { repaired, flattened, failed };
}

// ─── Route handler ──────────────────────────────────────────────────

export async function GET(req: Request) {
  const url = new URL(req.url);
  const enforce = url.searchParams.get("enforce") === "1";

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
  if (enforce && !audit.ok) {
    enforcement = await enforceProtection(audit, positions);
  }

  return NextResponse.json({
    ok: audit.ok,
    source: "broker-truth",
    brokerFetchedAt: brokerTruth.fetchedAt,
    auditedAt: audit.auditedAt,
    brokerIsFlat,
    openTrades: audit.tradeCount,
    protectedTrades: audit.protectedCount,
    unprotectedTrades: audit.tradeCount - audit.protectedCount,
    criticalCount: audit.criticalCount,
    incidentCount: audit.incidentCount,
    incidents: audit.incidents,
    details: audit.details,
    enforcement: enforcement || undefined,
    reconciliation: reconciliation.attempted ? reconciliation : undefined,
  });
}
