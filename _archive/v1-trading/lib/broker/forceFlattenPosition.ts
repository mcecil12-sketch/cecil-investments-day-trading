/**
 * forceFlattenPosition — Cancel all open orders for a symbol, then flatten
 * the broker position via DELETE /v2/positions/{symbol}.
 *
 * This is the canonical flatten helper.  It must be used instead of any
 * bare DELETE-position call so that blocking open orders do not cause
 * "insufficient qty available" errors.
 */

import { alpacaRequest } from "@/lib/alpaca";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJsonSafe(text: string): any {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return null;
  }
}

function isExitOrderLike(order: any): boolean {
  const type = String(order?.type ?? "").toLowerCase();
  return ["stop", "stop_limit", "trailing_stop", "limit", "market"].includes(type);
}

async function fetchSymbolOpenOrders(symbol: string): Promise<any[]> {
  const ordersResp = await alpacaRequest({
    method: "GET",
    path: `/v2/orders?status=open&symbols=${encodeURIComponent(symbol)}&limit=500`,
  });
  if (!ordersResp.ok) return [];
  const parsed = parseJsonSafe(ordersResp.text);
  return Array.isArray(parsed) ? parsed : [];
}

async function fetchPositionSnapshot(symbol: string): Promise<{ qty: number; qtyAvailable: number | null; heldForOrders: number | null }> {
  const verifyResp = await alpacaRequest({
    method: "GET",
    path: `/v2/positions/${encodeURIComponent(symbol)}`,
  });
  if (verifyResp.status === 404) {
    return { qty: 0, qtyAvailable: 0, heldForOrders: 0 };
  }
  if (!verifyResp.ok) {
    return { qty: 0, qtyAvailable: null, heldForOrders: null };
  }
  const pos = parseJsonSafe(verifyResp.text) ?? {};
  const qty = Math.abs(Number(pos?.qty ?? 0));
  const qtyAvailableRaw = pos?.qty_available ?? pos?.available ?? null;
  const qtyAvailable = qtyAvailableRaw == null ? null : Math.abs(Number(qtyAvailableRaw));
  const heldForOrders = qtyAvailable != null && Number.isFinite(qtyAvailable) ? Math.max(0, qty - qtyAvailable) : null;
  return { qty, qtyAvailable, heldForOrders };
}

async function cancelAndWaitForHeldRelease(symbol: string, maxPolls = 8): Promise<{ canceled: number; remainingOpen: number; heldForOrders: number | null; qtyAvailable: number | null }> {
  let canceled = 0;
  const openOrders = await fetchSymbolOpenOrders(symbol);
  for (const order of openOrders) {
    if (!order?.id) continue;
    if (!isExitOrderLike(order)) continue;
    try {
      await alpacaRequest({ method: "DELETE", path: `/v2/orders/${encodeURIComponent(String(order.id))}` });
      canceled++;
    } catch {
      // best effort
    }
  }

  let remainingOpen = 0;
  let heldForOrders: number | null = null;
  let qtyAvailable: number | null = null;
  for (let i = 0; i < maxPolls; i++) {
    await sleep(400);
    const [ordersNow, pos] = await Promise.all([
      fetchSymbolOpenOrders(symbol),
      fetchPositionSnapshot(symbol),
    ]);
    remainingOpen = ordersNow.filter(isExitOrderLike).length;
    heldForOrders = pos.heldForOrders;
    qtyAvailable = pos.qtyAvailable;
    if (remainingOpen === 0 && (heldForOrders == null || heldForOrders <= 0)) break;
  }

  return { canceled, remainingOpen, heldForOrders, qtyAvailable };
}

export interface ForceFlattenDiagnostics {
  cancelOrdersAttempted: boolean;
  cancelOrdersSucceeded: boolean;
  ordersFound: number;
  ordersCanceled: number;
  flattenAttempted: boolean;
  flattenSucceeded: boolean;
  brokerPositionExistsAfter: boolean | null;
  heldForOrdersBefore?: number | null;
  heldForOrdersAfterCancel?: number | null;
  qtyAvailableBefore?: number | null;
  qtyAvailableAfterCancel?: number | null;
  flattenRetries?: number;
  closeOrderId?: string | null;
  closeOrderStatus?: string | null;
  verifyPolls?: number;
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
    heldForOrdersBefore: null,
    heldForOrdersAfterCancel: null,
    qtyAvailableBefore: null,
    qtyAvailableAfterCancel: null,
    flattenRetries: 0,
    closeOrderId: null,
    closeOrderStatus: null,
    verifyPolls: 0,
  };

  const prePos = await fetchPositionSnapshot(ticker).catch(() => ({ qty: 0, qtyAvailable: null, heldForOrders: null }));
  diagnostics.heldForOrdersBefore = prePos.heldForOrders;
  diagnostics.qtyAvailableBefore = prePos.qtyAvailable;

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

    const waitResult = await cancelAndWaitForHeldRelease(ticker);
    diagnostics.ordersCanceled = Math.max(diagnostics.ordersCanceled, waitResult.canceled);
    diagnostics.heldForOrdersAfterCancel = waitResult.heldForOrders;
    diagnostics.qtyAvailableAfterCancel = waitResult.qtyAvailable;
    diagnostics.cancelOrdersSucceeded = waitResult.remainingOpen === 0;
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

    const maxRetries = 3;
    let flattenError: string | null = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      diagnostics.flattenRetries = attempt;
      const flattenResp = await alpacaRequest({
        method: "DELETE",
        path: `/v2/positions/${encodeURIComponent(ticker)}`,
      });

      if (flattenResp.ok) {
        const parsed = parseJsonSafe(flattenResp.text);
        const maybeOrderId = String(parsed?.id ?? parsed?.order_id ?? "");
        diagnostics.closeOrderId = maybeOrderId || null;
        diagnostics.closeOrderStatus = maybeOrderId
          ? String(parsed?.status || "").toLowerCase() || null
          : null;
      }

      // 404 means position is already gone — treat as success
      if (flattenResp.ok || flattenResp.status === 404) {
        diagnostics.flattenSucceeded = true;
        flattenError = null;
        break;
      }

      flattenError = `Flatten failed: HTTP ${flattenResp.status} — ${flattenResp.text}`;
      const lowered = String(flattenResp.text || "").toLowerCase();
      const heldBlocked = lowered.includes("held_for_orders") || lowered.includes("insufficient qty available");
      if (!heldBlocked || attempt === maxRetries) {
        break;
      }

      const waitResult = await cancelAndWaitForHeldRelease(ticker, 10);
      diagnostics.heldForOrdersAfterCancel = waitResult.heldForOrders;
      diagnostics.qtyAvailableAfterCancel = waitResult.qtyAvailable;
      await sleep(500);
    }

    if (!diagnostics.flattenSucceeded) {
      return {
        ok: false,
        step: "flatten",
        error: flattenError ?? "flatten_failed",
        diagnostics,
      };
    }
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
    const pendingStatuses = new Set([
      "new",
      "accepted",
      "pending_new",
      "pending_replace",
      "accepted_for_bidding",
      "held",
      "partially_filled",
    ]);

    let lastQty: number | null = null;
    let lastOrderStatus: string | null = diagnostics.closeOrderStatus ?? null;
    const maxVerifyPolls = 8;

    for (let poll = 1; poll <= maxVerifyPolls; poll++) {
      diagnostics.verifyPolls = poll;

      const posSnapshot = await fetchPositionSnapshot(ticker);
      lastQty = posSnapshot.qty;
      if (posSnapshot.qty <= 0) {
        diagnostics.brokerPositionExistsAfter = false;
        return { ok: true, step: "verify", diagnostics };
      }

      diagnostics.brokerPositionExistsAfter = true;

      if (diagnostics.closeOrderId) {
        const ordResp = await alpacaRequest({
          method: "GET",
          path: `/v2/orders/${encodeURIComponent(String(diagnostics.closeOrderId))}`,
        });
        if (ordResp.ok) {
          const ord = parseJsonSafe(ordResp.text) ?? {};
          lastOrderStatus = String(ord?.status || "").toLowerCase() || null;
          diagnostics.closeOrderStatus = lastOrderStatus;
        }
      }

      if (poll < maxVerifyPolls && lastOrderStatus && pendingStatuses.has(lastOrderStatus)) {
        await sleep(500);
        continue;
      }

      if (poll < maxVerifyPolls && (!diagnostics.closeOrderId || lastOrderStatus == null)) {
        await sleep(500);
        continue;
      }
    }

    return {
      ok: false,
      step: "verify",
      error: `Position still exists after flatten retries: qty=${lastQty ?? "unknown"}; close_order_status=${lastOrderStatus ?? "unknown"}`,
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
