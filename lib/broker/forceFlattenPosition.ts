/**
 * forceFlattenPosition — Cancel all open orders for a symbol, then flatten
 * the broker position via DELETE /v2/positions/{symbol}.
 *
 * This is the canonical flatten helper.  It must be used instead of any
 * bare DELETE-position call so that blocking open orders do not cause
 * "insufficient qty available" errors.
 */

import { alpacaRequest } from "@/lib/alpaca";

export interface ForceFlattenDiagnostics {
  cancelOrdersAttempted: boolean;
  cancelOrdersSucceeded: boolean;
  ordersFound: number;
  ordersCanceled: number;
  flattenAttempted: boolean;
  flattenSucceeded: boolean;
  brokerPositionExistsAfter: boolean | null;
}

export interface ForceFlattenResult {
  ok: boolean;
  /** The step at which the operation stopped (or "verify" on success). */
  step: "cancel_orders" | "flatten" | "verify";
  error?: string;
  diagnostics: ForceFlattenDiagnostics;
}

export async function forceFlattenPosition(
  symbol: string
): Promise<ForceFlattenResult> {
  const ticker = symbol.toUpperCase();

  const diagnostics: ForceFlattenDiagnostics = {
    cancelOrdersAttempted: false,
    cancelOrdersSucceeded: false,
    ordersFound: 0,
    ordersCanceled: 0,
    flattenAttempted: false,
    flattenSucceeded: false,
    brokerPositionExistsAfter: null,
  };

  // ── Step 1: Cancel ALL open orders for the symbol ─────────────────
  try {
    diagnostics.cancelOrdersAttempted = true;

    // Fetch all open orders scoped to this symbol
    const ordersResp = await alpacaRequest({
      method: "GET",
      path: `/v2/orders?status=open&symbols=${encodeURIComponent(ticker)}&limit=500`,
    });

    if (!ordersResp.ok) {
      return {
        ok: false,
        step: "cancel_orders",
        error: `Failed to fetch open orders: HTTP ${ordersResp.status} — ${ordersResp.text}`,
        diagnostics,
      };
    }

    let openOrders: any[] = [];
    try {
      const parsed = JSON.parse(ordersResp.text);
      openOrders = Array.isArray(parsed) ? parsed : [];
    } catch {
      openOrders = [];
    }
    diagnostics.ordersFound = openOrders.length;

    // Cancel each order individually (best-effort)
    for (const order of openOrders) {
      if (!order?.id) continue;
      try {
        await alpacaRequest({
          method: "DELETE",
          path: `/v2/orders/${encodeURIComponent(String(order.id))}`,
        });
        diagnostics.ordersCanceled++;
      } catch {
        // continue; individual order cancel errors don't abort the loop
      }
    }

    diagnostics.cancelOrdersSucceeded = true;
  } catch (err: any) {
    return {
      ok: false,
      step: "cancel_orders",
      error: `Order cancellation threw: ${err?.message ?? String(err)}`,
      diagnostics,
    };
  }

  // ── Step 2: Flatten the position ─────────────────────────────────
  try {
    diagnostics.flattenAttempted = true;

    const flattenResp = await alpacaRequest({
      method: "DELETE",
      path: `/v2/positions/${encodeURIComponent(ticker)}`,
    });

    // 404 means position is already gone — treat as success
    if (!flattenResp.ok && flattenResp.status !== 404) {
      return {
        ok: false,
        step: "flatten",
        error: `Flatten failed: HTTP ${flattenResp.status} — ${flattenResp.text}`,
        diagnostics,
      };
    }

    diagnostics.flattenSucceeded = true;
  } catch (err: any) {
    return {
      ok: false,
      step: "flatten",
      error: `Position close threw: ${err?.message ?? String(err)}`,
      diagnostics,
    };
  }

  // ── Step 3: Verify the position is gone ──────────────────────────
  try {
    const verifyResp = await alpacaRequest({
      method: "GET",
      path: `/v2/positions/${encodeURIComponent(ticker)}`,
    });

    // 404 → position gone → success
    if (verifyResp.status === 404) {
      diagnostics.brokerPositionExistsAfter = false;
      return { ok: true, step: "verify", diagnostics };
    }

    if (verifyResp.ok) {
      let qty = 0;
      try {
        const pos = JSON.parse(verifyResp.text);
        qty = Math.abs(Number(pos?.qty ?? 0));
      } catch {
        qty = 0;
      }
      diagnostics.brokerPositionExistsAfter = qty > 0;
      if (qty > 0) {
        return {
          ok: false,
          step: "verify",
          error: `Position still exists after flatten: qty=${qty}`,
          diagnostics,
        };
      }
      // qty === 0 → effectively gone
      return { ok: true, step: "verify", diagnostics };
    }

    // Non-200 non-404 verify response — uncertain
    diagnostics.brokerPositionExistsAfter = null;
    return {
      ok: false,
      step: "verify",
      error: `Verify request returned HTTP ${verifyResp.status}: ${verifyResp.text}`,
      diagnostics,
    };
  } catch (err: any) {
    return {
      ok: false,
      step: "verify",
      error: `Verify threw: ${err?.message ?? String(err)}`,
      diagnostics,
    };
  }
}
