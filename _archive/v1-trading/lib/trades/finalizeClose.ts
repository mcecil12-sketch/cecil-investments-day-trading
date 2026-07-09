import { alpacaRequest } from "@/lib/alpaca";

export type FinalizeCloseResult =
  | { ok: true; action: "FINALIZED"; closePrice: number; realizedPnL: number; realizedR: number; closeReason: string; qty: number }
  | { ok: true; action: "REOPENED"; reason: string }
  | { ok: true; action: "VOIDED"; reason: string }
  | { ok: false; action: "ERROR"; error: string; debug?: any };

type AnyTrade = Record<string, any>;

function num(v: any): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function avgPxFromFills(fills: any[]): number | null {
  let notional = 0;
  let qty = 0;
  for (const f of fills) {
    const q = num(f.qty);
    const p = num(f.price);
    if (!q || !p) continue;
    qty += q;
    notional += q * p;
  }
  if (!qty) return null;
  return notional / qty;
}

function sumQty(fills: any[]): number {
  let qty = 0;
  for (const f of fills) {
    const q = num(f.qty);
    if (q) qty += q;
  }
  return qty;
}

async function getOrderMaybe(id?: string | null) {
  if (!id) return { ok: false as const, status: 0, json: null as any, text: "" };
  const resp = await alpacaRequest({ method: "GET", path: `/v2/orders/${encodeURIComponent(id)}` });
  if (!resp.ok) return { ok: false as const, status: resp.status, json: null as any, text: resp.text || "" };
  try {
    return { ok: true as const, status: resp.status, json: JSON.parse(resp.text || "{}"), text: resp.text || "" };
  } catch {
    return { ok: false as const, status: resp.status, json: null as any, text: resp.text || "" };
  }
}

async function getFillsForSymbol(symbol: string, afterIso: string, untilIso: string) {
  const qs = new URLSearchParams({
    activity_types: "FILL",
    direction: "asc",
    page_size: "100",
    after: afterIso,
    until: untilIso,
  }).toString();
  const resp = await alpacaRequest({ method: "GET", path: `/v2/account/activities?${qs}` });
  if (!resp.ok) return { ok: false as const, status: resp.status, text: resp.text || "", fills: [] as any[] };
  try {
    const arr = JSON.parse(resp.text || "[]");
    const fills = Array.isArray(arr) ? arr.filter((a) => (a?.symbol || a?.sym) === symbol) : [];
    return { ok: true as const, status: resp.status, text: resp.text || "", fills };
  } catch {
    return { ok: false as const, status: resp.status, text: resp.text || "", fills: [] as any[] };
  }
}

function etWindow(trade: AnyTrade) {
  const now = Date.now();
  const executedAt = trade.executedAt ? Date.parse(trade.executedAt) : null;
  const closedAt = trade.closedAt ? Date.parse(trade.closedAt) : null;
  const base = executedAt || closedAt || now;
  const start = new Date(base - 1000 * 60 * 60 * 6).toISOString(); // -6h
  const end = new Date(base + 1000 * 60 * 60 * 24).toISOString(); // +24h
  return { start, end };
}

export async function finalizeTradeClose(trade: AnyTrade): Promise<FinalizeCloseResult> {
  try {
    const symbol = String(trade.ticker || trade.symbol || "").toUpperCase().trim();
    if (!symbol) return { ok: false, action: "ERROR", error: "missing_symbol" };

    const { start, end } = etWindow(trade);
    const fillsResp = await getFillsForSymbol(symbol, start, end);
    if (!fillsResp.ok) {
      return { ok: false, action: "ERROR", error: `fills_fetch_failed:${fillsResp.status}`, debug: { start, end, text: fillsResp.text } };
    }

    const fills = fillsResp.fills || [];
    const buys = fills.filter((f: any) => (f.side || f.order_side || "").toLowerCase() === "buy");
    const sells = fills.filter((f: any) => (f.side || f.order_side || "").toLowerCase() === "sell");

    // ── Side-aware fill assignment ───────────────────────────────────────────
    // LONG:  entry fills = buys,  exit fills = sells
    // SHORT: entry fills = sells, exit fills = buys
    const sideUpper = String(trade.side ?? "").toUpperCase();
    const entryFills = sideUpper === "SHORT" ? sells : buys;
    const exitFills  = sideUpper === "SHORT" ? buys  : sells;

    const entryAvg = avgPxFromFills(entryFills) ?? num(trade.avgFillPrice) ?? num(trade.entryFillPrice) ?? num(trade.entryPrice);
    const entryQty = sumQty(entryFills) || num(trade.quantity) || num(trade.qty) || 0;

    // If there was no entry fill, this should not be a CLOSED trade.
    if (!entryFills.length || !entryAvg || !entryQty) {
      // Try order lookup to see if it was canceled/expired.
      const ord = await getOrderMaybe(trade.alpacaOrderId || trade.brokerOrderId);
      const status = (ord.ok ? String(ord.json?.status || "") : "").toLowerCase();
      const reason =
        status ? `no_entry_fill_order_status:${status}` : "no_entry_fill_no_order";
      return { ok: true, action: "VOIDED", reason };
    }

    // Determine exit fills: use side-aware exitFills slice.
    const exitQtyVal = sumQty(exitFills);
    const exitAvg = avgPxFromFills(exitFills);

    if (!exitFills.length || !exitAvg || !exitQtyVal) {
      // Entry filled but no exit found => trade is still OPEN (or close not executed).
      return { ok: true, action: "REOPENED", reason: "entry_fill_found_no_exit_fill" };
    }

    const qty = Math.min(entryQty, exitQtyVal);

    // ── PnL: side-aware, LONG and SHORT ─────────────────────────────────────
    const pnlPerShare = sideUpper === "SHORT" ? entryAvg - exitAvg : exitAvg - entryAvg;
    const realizedPnL = pnlPerShare * qty;

    // ── R: use actual fill-based entry, not stored trade.entryPrice ──────────
    // Prefer the original/initial stop (set at inception) for the risk denominator.
    const sp = num(trade.originalStopPrice ?? trade.initialStopPrice ?? trade.stopPrice);
    const riskPs = sp != null && sp > 0 ? Math.abs(entryAvg - sp) : null;
    const realizedR = riskPs && riskPs > 0 ? pnlPerShare / riskPs : 0;

    // ── R anomaly guard ──────────────────────────────────────────────────────
    if (Math.abs(realizedR) > 3) {
      console.error("R_ANOMALY", {
        tradeId: trade.id ?? trade.alpacaOrderId ?? "unknown",
        realizedR,
        entryPrice: entryAvg,
        avgExitPrice: exitAvg,
        stopPrice: sp,
      });
    }

    // Heuristic close reason: prefer leg IDs if present in exit fill order IDs.
    // For SHORT, exit fills are buys; for LONG, exit fills are sells.
    let closeReason = "exit_fill";
    const legIds = new Set<string>([
      trade.stopOrderId,
      trade.takeProfitOrderId,
      trade.alpacaOrderId,
      trade.brokerOrderId,
    ].filter(Boolean));
    const exitOrderIds = new Set<string>(exitFills.map((f: any) => String(f.order_id || f.orderId || f.id || "")));
    if (trade.takeProfitOrderId && exitOrderIds.has(String(trade.takeProfitOrderId))) closeReason = "take_profit_hit";
    if (trade.stopOrderId && exitOrderIds.has(String(trade.stopOrderId))) closeReason = "stop_hit";
    if (legIds.size && [...exitOrderIds].some((id) => legIds.has(id))) closeReason = closeReason === "exit_fill" ? "broker_leg_fill" : closeReason;

    return { ok: true, action: "FINALIZED", closePrice: exitAvg, realizedPnL, realizedR, closeReason, qty };
  } catch (e: any) {
    return { ok: false, action: "ERROR", error: e?.message || "finalize_exception" };
  }
}

