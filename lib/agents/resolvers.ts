/**
 * Real incident resolvers for autonomous self-heal.
 *
 * Each resolver attempts a concrete corrective action against the Alpaca
 * broker, then returns a structured result. The caller (execute route)
 * runs post-fix verification *after* the resolver returns.
 *
 * Resolver contracts:
 *   - MUST NOT throw — all errors captured in ActionResult.error
 *   - MUST be idempotent (safe to retry)
 *   - MUST NOT resolve the Redis critical task (caller does that)
 */

import { alpacaHeaders, tradingUrl } from "@/lib/alpaca";
import { fetchBrokerTruth, type BrokerTruth } from "@/lib/broker/truth";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import {
  normalizeTicker,
  isOpenTradeStatus,
} from "@/lib/trades/protection";
import {
  envFlag,
  parseQty,
  type BrokerPosition,
} from "@/lib/risk/protection-integrity";
import type { CriticalTask } from "@/lib/redis";

// ─── Types ──────────────────────────────────────────────────────────

export type ActionResult = {
  attempted: boolean;
  action: string;
  ok: boolean;
  detail: string;
  orderId?: string;
};

// ─── Broker primitives ──────────────────────────────────────────────

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

// ─── Helpers ────────────────────────────────────────────────────────

function findBrokerPosition(
  truth: BrokerTruth,
  symbol: string,
): BrokerPosition | undefined {
  const norm = normalizeTicker(symbol);
  return truth.positions.find(
    (p) => normalizeTicker(p.symbol) === norm,
  ) as BrokerPosition | undefined;
}

function computeEmergencyStop(pos: BrokerPosition): {
  side: "buy" | "sell";
  stopPrice: number;
} {
  const posSide =
    String(pos.side || "").toLowerCase() === "short" ? "short" : "long";
  const side: "buy" | "sell" = posSide === "long" ? "sell" : "buy";
  const entryPrice = Number(pos.avg_entry_price ?? 0);
  const stopPrice =
    posSide === "long"
      ? Math.round(entryPrice * 0.98 * 100) / 100
      : Math.round(entryPrice * 1.02 * 100) / 100;
  return { side, stopPrice };
}

// ─── Resolvers ──────────────────────────────────────────────────────

/**
 * MISSING_STOP / STOP_EXPIRED / STOP_CANCELED / STOP_DAY_TIF
 * Action: place a GTC stop order at 2 % from entry using broker qty.
 */
async function resolveStopNeeded(
  task: CriticalTask,
  truth: BrokerTruth,
): Promise<ActionResult> {
  const symbol = normalizeTicker(task.symbol);
  const pos = findBrokerPosition(truth, symbol);
  if (!pos) {
    return {
      attempted: true,
      action: "repair_stop",
      ok: false,
      detail: `No broker position found for ${symbol}; cannot place stop`,
    };
  }

  const brokerQty = parseQty(pos.qty);
  if (brokerQty <= 0) {
    return {
      attempted: true,
      action: "repair_stop",
      ok: false,
      detail: `Broker position qty is 0 for ${symbol}`,
    };
  }

  const entryPrice = Number(pos.avg_entry_price ?? 0);
  if (!entryPrice) {
    return {
      attempted: true,
      action: "repair_stop",
      ok: false,
      detail: `No entry price available for ${symbol}`,
    };
  }

  const { side, stopPrice } = computeEmergencyStop(pos);
  const result = await submitRepairStop({
    symbol,
    qty: brokerQty,
    side,
    stopPrice,
  });

  if (result.ok) {
    console.log("[resolvers] repaired stop", {
      symbol,
      qty: brokerQty,
      stopPrice,
      orderId: result.orderId,
    });
    return {
      attempted: true,
      action: "repair_stop",
      ok: true,
      detail: `Placed GTC stop at ${stopPrice} for ${brokerQty} shares`,
      orderId: result.orderId,
    };
  }

  return {
    attempted: true,
    action: "repair_stop",
    ok: false,
    detail: `submitRepairStop failed: ${result.error}`,
  };
}

/**
 * STOP_REPAIR_FAILED
 * Action: retry repair stop. If that also fails and RISK_FLATTEN_ON_REPAIR_FAIL
 * is enabled, flatten the position.
 */
async function resolveStopRepairFailed(
  task: CriticalTask,
  truth: BrokerTruth,
): Promise<ActionResult> {
  // First try a fresh repair stop
  const repairResult = await resolveStopNeeded(task, truth);
  if (repairResult.ok) return repairResult;

  // Repair still failing — attempt flatten if enabled
  if (envFlag("RISK_FLATTEN_ON_REPAIR_FAIL")) {
    const symbol = normalizeTicker(task.symbol);
    const flat = await flattenPosition(symbol);
    if (flat.ok) {
      console.log("[resolvers] flattened after repair retry failure", { symbol });
      return {
        attempted: true,
        action: "flatten_after_repair_fail",
        ok: true,
        detail: `Repair retry failed; position flattened for ${symbol}`,
      };
    }
    return {
      attempted: true,
      action: "flatten_after_repair_fail",
      ok: false,
      detail: `Repair retry failed (${repairResult.detail}); flatten also failed: ${flat.error}`,
    };
  }

  return {
    attempted: true,
    action: "repair_stop_retry",
    ok: false,
    detail: `Repair retry failed (${repairResult.detail}); flatten disabled`,
  };
}

/**
 * FLATTEN_FAILED
 * Action: retry flatten.
 */
async function resolveFlattenFailed(
  task: CriticalTask,
): Promise<ActionResult> {
  const symbol = normalizeTicker(task.symbol);
  const flat = await flattenPosition(symbol);
  if (flat.ok) {
    console.log("[resolvers] flatten retry succeeded", { symbol });
    return {
      attempted: true,
      action: "flatten_retry",
      ok: true,
      detail: `Flatten retry succeeded for ${symbol}`,
    };
  }
  return {
    attempted: true,
    action: "flatten_retry",
    ok: false,
    detail: `Flatten retry failed: ${flat.error}`,
  };
}

/**
 * BROKER_DB_MISMATCH
 * Action:
 *   - If broker has no position → mark DB trade as closed
 *   - If broker has a position but DB doesn't → log only (do not open trades autonomously)
 *   - If both exist but qty differs → update DB qty to match broker
 */
async function resolveBrokerDbMismatch(
  task: CriticalTask,
  truth: BrokerTruth,
): Promise<ActionResult> {
  const symbol = normalizeTicker(task.symbol);
  const pos = findBrokerPosition(truth, symbol);

  let allTrades: Record<string, any>[];
  try {
    allTrades = await readTrades<Record<string, any>>();
  } catch {
    return {
      attempted: true,
      action: "reconcile_db",
      ok: false,
      detail: `Failed to read trades from DB for ${symbol}`,
    };
  }

  const tradeIdx = allTrades.findIndex(
    (t) =>
      normalizeTicker(t.ticker) === symbol && isOpenTradeStatus(t.status),
  );

  // No broker position → close the DB trade
  if (!pos || parseQty(pos.qty) === 0) {
    if (tradeIdx === -1) {
      // Both gone — nothing to do, consider resolved
      return {
        attempted: true,
        action: "reconcile_db",
        ok: true,
        detail: `No broker position and no open DB trade for ${symbol}; mismatch already resolved`,
      };
    }

    allTrades[tradeIdx] = {
      ...allTrades[tradeIdx],
      status: "closed",
      closeReason: "broker_reconciliation",
      closedAt: new Date().toISOString(),
    };
    try {
      await writeTrades(allTrades);
    } catch (err: any) {
      return {
        attempted: true,
        action: "reconcile_db",
        ok: false,
        detail: `Failed to write closed trade for ${symbol}: ${err?.message || String(err)}`,
      };
    }

    console.log("[resolvers] reconciled DB: closed trade with no broker position", { symbol });
    return {
      attempted: true,
      action: "reconcile_db_close",
      ok: true,
      detail: `Closed DB trade for ${symbol} — no broker position exists`,
    };
  }

  // Broker has a position
  if (tradeIdx === -1) {
    // Broker position with no DB trade — log, but don't open a trade autonomously
    return {
      attempted: true,
      action: "reconcile_db",
      ok: false,
      detail: `Broker has position for ${symbol} but no open DB trade; manual reconciliation required`,
    };
  }

  // Both exist — sync qty
  const brokerQty = parseQty(pos.qty);
  const dbQty = Number(allTrades[tradeIdx].size || allTrades[tradeIdx].qty || 0);
  if (Math.abs(brokerQty - dbQty) > 0.001) {
    allTrades[tradeIdx] = {
      ...allTrades[tradeIdx],
      size: brokerQty,
      qty: brokerQty,
    };
    try {
      await writeTrades(allTrades);
    } catch (err: any) {
      return {
        attempted: true,
        action: "reconcile_db",
        ok: false,
        detail: `Failed to update qty for ${symbol}: ${err?.message || String(err)}`,
      };
    }

    console.log("[resolvers] reconciled DB: synced qty", {
      symbol,
      dbQty,
      brokerQty,
    });
    return {
      attempted: true,
      action: "reconcile_db_qty",
      ok: true,
      detail: `Synced DB qty ${dbQty} → ${brokerQty} for ${symbol}`,
    };
  }

  // Qty matches — mismatch may be from side or other field
  return {
    attempted: true,
    action: "reconcile_db",
    ok: true,
    detail: `DB and broker data in sync for ${symbol}; mismatch may have self-resolved`,
  };
}

// ─── Dispatcher ─────────────────────────────────────────────────────

/**
 * Run the appropriate corrective action for a critical task.
 * Returns the action result — caller handles verification + Redis resolution.
 */
export async function runIncidentResolver(
  task: CriticalTask,
): Promise<ActionResult> {
  // Fetch fresh broker truth (bypass cache by waiting for cache TTL or accepting cached)
  let truth: BrokerTruth;
  try {
    truth = await fetchBrokerTruth();
  } catch (err: any) {
    return {
      attempted: false,
      action: "fetch_broker_truth",
      ok: false,
      detail: `broker truth unavailable: ${err?.message || String(err)}`,
    };
  }

  if (truth.error) {
    return {
      attempted: false,
      action: "fetch_broker_truth",
      ok: false,
      detail: `broker truth error: ${truth.error}`,
    };
  }

  const code = task.incidentCode;

  switch (code) {
    case "MISSING_STOP":
    case "STOP_EXPIRED":
    case "STOP_CANCELED":
    case "STOP_DAY_TIF":
      return resolveStopNeeded(task, truth);

    case "STOP_REPAIR_FAILED":
      return resolveStopRepairFailed(task, truth);

    case "FLATTEN_FAILED":
      return resolveFlattenFailed(task);

    case "BROKER_DB_MISMATCH":
      return resolveBrokerDbMismatch(task, truth);

    default:
      return {
        attempted: false,
        action: "unknown",
        ok: false,
        detail: `No resolver for incident code: ${code}`,
      };
  }
}
