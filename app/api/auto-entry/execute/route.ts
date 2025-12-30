import { NextResponse } from "next/server";
import { getAutoConfig, tierForScore, riskMultForTier } from "@/lib/autoEntry/config";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import { alpacaRequest, createOrder } from "@/lib/alpaca";
import { redis } from "@/lib/redis";

export const dynamic = "force-dynamic";

async function hasOpenOrdersForSymbol(symbol: string) {
  const qs = `status=open&symbols=${encodeURIComponent(symbol)}&limit=50`;
  const resp = await alpacaRequest({ method: "GET", path: `/v2/orders?${qs}` });
  if (!resp.ok) return { ok: false as const, status: resp.status, text: resp.text || "" };

  try {
    const parsed = JSON.parse(resp.text || "[]");
    const orders = Array.isArray(parsed) ? parsed : [];
    return { ok: true as const, orders };
  } catch {
    return { ok: true as const, orders: [] as any[] };
  }
}


function safeNum(v: any, fb = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

function headerToken(req: Request) {
  return req.headers.get("x-auto-entry-token") || "";
}

function nowIso() {
  return new Date().toISOString();
}

async function ensureToken(req: Request) {
  const cfg = getAutoConfig();
  if (!cfg.token) return { ok: false as const, status: 500, error: "AUTO_ENTRY_TOKEN missing" };
  const got = headerToken(req);
  if (!got || got !== cfg.token) return { ok: false as const, status: 401, error: "unauthorized" };
  return { ok: true as const, cfg };
}

async function setnxLock(key: string, ttlSec: number) {
  if (!redis) return false;
  const ok = await redis.set(key, "1", { nx: true, ex: ttlSec });
  return Boolean(ok);
}

function computeQty(entryPrice: number, stopPrice: number, riskDollars: number) {
  const diff = Math.abs(entryPrice - stopPrice);
  if (!diff || diff <= 0) return 1;
  const qty = Math.floor(riskDollars / diff);
  return Math.max(1, qty);
}

async function listOpenOrders(symbol: string) {
  const qs = `status=open&symbols=${encodeURIComponent(symbol)}`;
  const resp = await alpacaRequest({ method: "GET", path: `/v2/orders?${qs}` });
  if (!resp.ok) return [];
  try {
    const parsed = JSON.parse(resp.text || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function cancelOrder(id: string) {
  const resp = await alpacaRequest({ method: "DELETE", path: `/v2/orders/${id}` });
  return resp.ok || resp.status === 404;
}

async function cancelConflictingOrders(symbol: string, entrySide: "buy" | "sell") {
  const open = await listOpenOrders(symbol);
  const cancels = [];
  for (const o of open) {
    const oSide = String(o?.side || "").toLowerCase();
    const oType = String(o?.type || "").toLowerCase();
    const id = String(o?.id || "");
    if (!id) continue;

    // Conflict definition: opposite-side stop/market orders (exact Alpaca reject cause)
    const opposite = (entrySide === "buy" && oSide === "sell") || (entrySide === "sell" && oSide === "buy");
    const isStopOrMkt = (["stop","market"].includes(oType));
    if (opposite && isStopOrMkt) {
      cancels.push(id);
    }
  }

  const results = [];
  for (const id of cancels) {
    try {
      const ok = await cancelOrder(id);
      results.push({ id, ok });
    } catch (e) {
      results.push({ id, ok: false, error: String(e) });
    }
  }

  return { cancelled: results, openCount: open.length };
}

export async function POST(req: Request) {
  const auth = await ensureToken(req);
  if (!auth.ok) return NextResponse.json(auth, { status: auth.status });

  const cfg = auth.cfg;

  if (!cfg.enabled) {
    return NextResponse.json({ ok: true, skipped: true, reason: "AUTO_TRADING_ENABLED=false" }, { status: 200 });
  }
  if (!cfg.paperOnly) {
    return NextResponse.json({ ok: true, skipped: true, reason: "AUTO_TRADING_PAPER_ONLY=false (blocked in Phase 4)" }, { status: 200 });
  }

  const trades = await readTrades<any>();
  const idx = trades.findIndex((t: any) => t && t.status === "AUTO_PENDING" && t.source === "auto-entry");
  if (idx === -1) {
    return NextResponse.json({ ok: true, skipped: true, reason: "no_AUTO_PENDING_trades" }, { status: 200 });
  }

  const trade = trades[idx];

  const open = await hasOpenOrdersForSymbol(trade.ticker);
  if (!open.ok) {
    return NextResponse.json(
      { ok: false, status: open.status, error: open.text || "alpaca open orders lookup failed", tradeId: trade.id },
      { status: 500 }
    );
  }
  if (open.orders.length > 0) {
    return NextResponse.json(
      { ok: true, skipped: true, reason: "open_order_exists", tradeId: trade.id, openOrders: open.orders.map((o: any) => ({ id: o.id, symbol: o.symbol, side: o.side, type: o.type, status: o.status })) },
      { status: 200 }
    );
  }

  const tradeId = String(trade.id || "");
  if (!tradeId) {
    return NextResponse.json({ ok: false, error: "trade missing id" }, { status: 400 });
  }

  const lockKey = `auto:exec:lock:${tradeId}`;
  const locked = await setnxLock(lockKey, 60 * 10);
  if (!locked) {
    return NextResponse.json({ ok: true, skipped: true, reason: "already_locked", tradeId }, { status: 200 });
  }

  const ticker = String(trade.ticker || "").toUpperCase();
  const side = String(trade.side || "LONG").toUpperCase();
  const entryPrice = safeNum(trade.entryPrice, 0);
  const stopPrice = safeNum(trade.stopPrice, 0);

  if (!ticker || (side !== "LONG" && side !== "SHORT") || entryPrice <= 0 || stopPrice <= 0) {
    return NextResponse.json({ ok: false, error: "trade missing ticker/side/entryPrice/stopPrice", tradeId }, { status: 400 });
  }

  const score = safeNum(trade.ai?.score ?? trade.score ?? 0, 0);
  const tier = tierForScore(score) || "C";
  const riskMult = riskMultForTier(tier);
  const riskDollars = cfg.baseRiskDollars * riskMult;

  const qty = computeQty(entryPrice, stopPrice, riskDollars);

  const startedAt = nowIso();

  try {
    const sideDirection = side === "LONG" ? "buy" : "sell";
    const order = await createOrder({
      symbol: ticker,
      qty,
      side: sideDirection,
      type: "market",
      time_in_force: "day",
      order_class: "bracket",
      stop_loss: { stop_price: stopPrice },
    });

    const legs = Array.isArray(order?.legs) ? order.legs : [];
    const findLeg = (keywords: string[]) =>
      legs.find((leg) => {
        const type = String(leg?.type ?? "").toLowerCase();
        return keywords.some((kw) => type.includes(kw));
      });
    const stopChild = order?.stop_loss ?? findLeg(["stop_loss", "stop"]);
    const takeProfitChild = order?.take_profit ?? findLeg(["take_profit", "limit", "profit"]);
    const stopOrderId = stopChild?.id ?? null;
    const takeProfitOrderId = takeProfitChild?.id ?? null;
    const normalizedLegs = legs.map((leg: any) => ({
      id: leg?.id ?? null,
      type: leg?.type ?? null,
      side: leg?.side ?? null,
      status: leg?.status ?? null,
    }));

    const updated = {
      ...trade,
      quantity: qty,
      status: "OPEN",
      submitToBroker: true,
      brokerOrderId: order.id,
      brokerStatus: order.status,
      brokerRaw: order,
      alpacaOrderId: order.id,
      alpacaStatus: order.status,
      stopOrderId,
      takeProfitOrderId,
      lastStopAppliedAt: startedAt,
      error: undefined,
      updatedAt: startedAt,
      executedAt: startedAt,
      ai: {
        ...(trade.ai || {}),
        score,
        tier,
        riskMult,
        riskDollars,
      },
      paper: true,
    };

    trades[idx] = updated;
    await writeTrades(trades);

    return NextResponse.json(
      {
        ok: true,
        trade: updated,
        broker: {
          id: order.id,
          status: order.status,
          order_class: order.order_class ?? "bracket",
          legs: normalizedLegs,
          stopOrderId,
          takeProfitOrderId,
        },
      },
      { status: 200 }
    );
  } catch (err: any) {
    const message = err?.message ?? String(err);
    const failed = {
      ...trade,
      status: "ERROR",
      error: message,
      updatedAt: nowIso(),
    };
    trades[idx] = failed;
    await writeTrades(trades);
    return NextResponse.json({ ok: false, error: message, tradeId }, { status: 500 });
  }
}
