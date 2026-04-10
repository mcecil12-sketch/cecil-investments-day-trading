import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getPositions, getOrder, replaceOrder, createOrder, alpacaRequest } from "@/lib/alpaca";
import { appendActivity } from "@/lib/activity";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import { etDateString } from "@/lib/autoEntry/guardrails";
import * as guardrailsStore from "@/lib/autoEntry/guardrailsStore";
import { NotificationEvent } from "@/lib/notifications/types";
import { sendNotification } from "@/lib/notifications/notify";
import { getAllSignals } from "@/lib/signalsStore";
import { normalizeStopPrice, tickForEquityPrice } from "@/lib/tickSize";
import { ProtectionStatus } from "@/lib/trades/protection";
import { saveCriticalTask } from "@/lib/redis";
import { auditProtectionIntegrity, envFlag, parseQty } from "@/lib/risk/protection-integrity";

async function fireNotification(event: NotificationEvent) {
  try {
    await sendNotification(event);
  } catch (err) {
    console.error("[notify] trades manage event failed", err);
  }
}

let __signalsCache: any[] | null = null;

async function getSignalById(id: string) {
  if (!id) return null;
  try {
    if (__signalsCache == null) {
      const all = await getAllSignals();
      __signalsCache = Array.isArray(all) ? all : [];
    }
    return (__signalsCache || []).find((x: any) => String(x?.id || "") === String(id)) || null;
  } catch {
    return null;
  }
}

function inferTradeScore(t: any): number | null {
  const v = t?.score ?? t?.aiScore ?? t?.ai?.score ?? t?.signalScore;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function inferTradeTier(t: any): any {
  const raw = String(t?.tier ?? t?.ai?.tier ?? "").toUpperCase();
  if (raw === "A" || raw === "B" || raw === "C" || raw === "REJECT") return raw;
  const g = String(t?.grade ?? t?.ai?.grade ?? "").toUpperCase();
  if (g === "A" || g === "B" || g === "C") return g;
  const sc = inferTradeScore(t);
  if (sc == null) return undefined;
  if (sc >= 8.5) return "A";
  if (sc >= 7.5) return "B";
  if (sc >= 6.5) return "C";
  return "REJECT";
}

function inferTradeGrade(t: any): string | undefined {
  const g = t?.grade ?? t?.ai?.grade;
  return typeof g === "string" && g ? g : undefined;
}

type TradeStatus = "OPEN" | "CLOSED" | "PENDING" | "PARTIAL" | string;

type Trade = {
  id: string;
  ticker: string;
  side: string;
  size: number;
  status: TradeStatus;
  entryPrice: number;
  openedAt: string;
  closedAt?: string;
  updatedAt?: string;
  realizedPnL?: number;
  realizedR?: number;
  closeReason?: string;
  alpacaOrderId?: string;
  alpacaClientOrderId?: string;
  alpacaStatus?: string;
  initialDollarRisk?: number;
  oneR?: number;
  unrealizedPnL?: number;
  unrealizedR?: number;
  suggestedStopPrice?: number;
  stopSuggestionReason?: string;
  lastStopAppliedAt?: string;
  score?: number;
  aiScore?: number;
  ai?: { score?: number; grade?: string; tier?: string };
  tier?: string;
  grade?: string;
  signalScore?: number;
  signalTier?: string;
  signalGrade?: string;
  signalId?: string;
  protectionStatus?: ProtectionStatus;
  protectionVerifiedAt?: string;
  protectionIssue?: string;
  lastProtectionCheckAt?: string;
};

async function readSettings(): Promise<{ autoManagementEnabled?: boolean }> {
  const settingsPath = path.join(process.cwd(), "data", "settings.json");
  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    return JSON.parse(raw);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { autoManagementEnabled: false };
    }
    throw err;
  }
}

async function autoApplyStop(trade: Trade, nowIso: string) {
  if (!trade.alpacaOrderId || trade.suggestedStopPrice == null) {
    throw new Error("Missing alpaca order or suggested stop");
  }
  const order = await getOrder(trade.alpacaOrderId);
  const legs = order.legs || [];
  const stopLeg = (legs as any[]).find(
    (leg: any) =>
      leg &&
      typeof leg.stop_price !== "undefined" &&
      leg.side &&
      leg.side.toLowerCase() !== order.side?.toLowerCase()
  );
  if (!stopLeg?.id) {
    throw new Error("Stop leg not found");
  }
  const oldStop = stopLeg.stop_price;
  let newStop = trade.suggestedStopPrice;

  // Normalize stop price before submission
  const entryPrice = Number(trade.entryPrice ?? 0);
  const tick = tickForEquityPrice(entryPrice);
  const normResult = normalizeStopPrice({
    side: (trade.side?.toUpperCase() as "LONG" | "SHORT") || "LONG",
    entryPrice,
    stopPrice: newStop,
    tick,
  });

  if (!normResult.ok) {
    throw new Error(
      `Cannot apply stop: normalization failed (${normResult.reason}) for ${newStop}`
    );
  }

  newStop = normResult.stop;
  await replaceOrder(stopLeg.id, { stop_price: newStop });
  console.log("[manage] auto-applied stop", {
    id: trade.id,
    ticker: trade.ticker,
    from: oldStop,
    to: newStop,
    stopLegId: stopLeg.id,
  });
  await appendActivity({
    type: "AUTO_STOP_APPLIED",
    tradeId: trade.id,
    ticker: trade.ticker,
    message: `Auto stop applied ${oldStop} -> ${newStop}`,
    meta: { stopLegId: stopLeg.id },
  });
  return {
    ...trade,
    stopPrice: newStop,
    suggestedStopPrice: undefined,
    stopSuggestionReason: undefined,
    lastStopAppliedAt: nowIso,
    updatedAt: nowIso,
  };
}

export async function GET() {
  try {
    const trades = await readTrades<Trade>();
    const nowIso = new Date().toISOString();
    const settings = await readSettings();
    const autoEnabled = !!settings.autoManagementEnabled;

    let alpacaError: any = null;
    let alpacaPositionsRaw: any = [];
    try {
      alpacaPositionsRaw = await getPositions();
    } catch (err) {
      alpacaError = err;
      console.error("[manage] getPositions failed", err);
      alpacaPositionsRaw = [];
    }
    const alpacaPositions = Array.isArray(alpacaPositionsRaw)
      ? alpacaPositionsRaw
      : alpacaPositionsRaw
      ? [alpacaPositionsRaw]
      : [];

    const posBySymbol = new Map<string, any>();
    alpacaPositions.forEach((p: any) => {
      if (p?.symbol) posBySymbol.set(p.symbol.toUpperCase(), p);
    });

    let changed = false;
    const closedWithOrder: Trade[] = [];
    const updatedTrades = trades.map((t) => {
      const statusUpper = (t.status || "").toUpperCase();
      const isManagedStatus = ["OPEN", "PENDING", "PARTIAL"].includes(
        statusUpper
      );
      if (!isManagedStatus) return t;

      const hasPos = posBySymbol.has(t.ticker.toUpperCase());
      let nextStatus: TradeStatus = t.status;
      const pos = posBySymbol.get(t.ticker.toUpperCase());

      if (hasPos && statusUpper === "PENDING") {
        nextStatus = "OPEN";
      } else if (!hasPos && (statusUpper === "OPEN" || statusUpper === "PARTIAL")) {
        nextStatus = "CLOSED";
      }

      if (nextStatus !== t.status) {
        changed = true;
        console.log("[manage] status change", {
          id: t.id,
          ticker: t.ticker,
          from: t.status,
          to: nextStatus,
        });
        const nextTrade = { ...t, status: nextStatus, updatedAt: nowIso };
        if (nextStatus === "CLOSED" && !nextTrade.closedAt) nextTrade.closedAt = nowIso;
        if (nextStatus === "CLOSED" && !nextTrade.closeReason) {
          nextTrade.closeReason = "manual_close";
        }
        if (nextStatus === "CLOSED" && t.alpacaOrderId && typeof t.realizedPnL !== "number") {
          closedWithOrder.push(nextTrade);
        }
        return nextTrade;
      }

      // If position exists and trade is OPEN/PARTIAL, compute unrealized PnL/R and suggestions
      if (pos && (statusUpper === "OPEN" || statusUpper === "PARTIAL")) {
        const marketValue = Number(pos.market_value ?? 0);
        const costBasis = Number(pos.cost_basis ?? 0);
        const qty = Number(pos.qty ?? t.size);
        if (Number.isFinite(marketValue) && Number.isFinite(costBasis)) {
          const unrealizedPnL = marketValue - costBasis;
          const oneR = t.oneR ?? t.initialDollarRisk;
          const unrealizedR =
            oneR && oneR !== 0 ? unrealizedPnL / oneR : undefined;
          console.log("[manage] unrealized updated", {
            id: t.id,
            ticker: t.ticker,
            unrealizedPnL,
            unrealizedR,
          });

          // Advisory stop suggestions
          let suggestedStopPrice = t.suggestedStopPrice;
          let stopSuggestionReason = t.stopSuggestionReason;
          const entry = t.entryPrice ?? 0;
          const oneRVal = oneR ?? 0;
          if (
            unrealizedR != null &&
            unrealizedR >= 1 &&
            suggestedStopPrice == null
          ) {
            suggestedStopPrice = entry;
            stopSuggestionReason = "Move stop to breakeven at 1R";
            // Normalize the suggested stop
            const tick = tickForEquityPrice(entry);
            const normBE = normalizeStopPrice({
              side: (t.side?.toUpperCase() as "LONG" | "SHORT") || "LONG",
              entryPrice: entry,
              stopPrice: suggestedStopPrice,
              tick,
            });
            if (normBE.ok) suggestedStopPrice = normBE.stop;
            console.log("[manage] stop suggestion BE", {
              id: t.id,
              ticker: t.ticker,
              suggestedStopPrice,
            });
          }
          if (unrealizedR != null && unrealizedR >= 2 && oneRVal > 0) {
            const lockInRaw = t.side.toUpperCase() === "LONG"
              ? entry + oneRVal / t.size
              : entry - oneRVal / t.size;
            // Normalize the computed stop
            const tick = tickForEquityPrice(entry);
            const normLock = normalizeStopPrice({
              side: (t.side?.toUpperCase() as "LONG" | "SHORT") || "LONG",
              entryPrice: entry,
              stopPrice: lockInRaw,
              tick,
            });
            suggestedStopPrice = normLock.ok ? normLock.stop : lockInRaw;
            stopSuggestionReason = "Lock at +1R (advisory)";
            console.log("[manage] stop suggestion lock", {
              id: t.id,
              ticker: t.ticker,
              suggestedStopPrice,
            });
          }

          if (
            t.unrealizedPnL !== unrealizedPnL ||
            t.unrealizedR !== unrealizedR ||
            suggestedStopPrice !== t.suggestedStopPrice ||
            stopSuggestionReason !== t.stopSuggestionReason
          ) {
            changed = true;
            return {
              ...t,
              unrealizedPnL,
              unrealizedR,
              suggestedStopPrice,
              stopSuggestionReason,
              updatedAt: nowIso,
            };
          }
        }
      }

      return t;
    });

    // If auto-management enabled, apply suggested stops automatically
    if (autoEnabled && !alpacaError) {
      for (let i = 0; i < updatedTrades.length; i++) {
        const t = updatedTrades[i];
        const statusUpper = (t.status || "").toUpperCase();
        const canApply =
          t.suggestedStopPrice != null &&
          t.alpacaOrderId &&
          (statusUpper === "OPEN" || statusUpper === "PARTIAL");
        if (!canApply) continue;
        try {
          const applied = await autoApplyStop(t, nowIso);
          updatedTrades[i] = applied;
          changed = true;
        } catch (err) {
          console.error("[manage] auto-apply stop failed", {
            id: t.id,
            ticker: t.ticker,
            err,
          });
        }
      }
    }

    if (changed) {
      await writeTrades(updatedTrades);
    }

    // Compute realized PnL for newly closed trades with Alpaca orders
    for (const t of closedWithOrder) {
      try {
        const order = await getOrder(t.alpacaOrderId as string);
        const entryPrice = order.filled_avg_price
          ? Number(order.filled_avg_price)
          : null;

        const legs = order.legs || [];
        const exitLeg = (legs as any[]).find(
          (leg: any) =>
            leg?.filled_avg_price &&
            leg.status?.toLowerCase() === "filled" &&
            leg.side &&
            leg.side.toLowerCase() !== order.side?.toLowerCase()
        );
        const exitPrice = exitLeg?.filled_avg_price
          ? Number(exitLeg.filled_avg_price)
          : null;

        if (entryPrice != null && exitPrice != null) {
          const pnl =
            t.side.toUpperCase() === "LONG"
              ? (exitPrice - entryPrice) * t.size
              : (entryPrice - exitPrice) * t.size;
          const oneR = t.initialDollarRisk ?? undefined;
          const realizedR =
            oneR && oneR !== 0 ? pnl / oneR : undefined;

          console.log("[manage] realizedPnL computed", {
            id: t.id,
            ticker: t.ticker,
            pnl,
            realizedR,
            entryPrice,
            exitPrice,
          });

          // update in updatedTrades
          const idx = updatedTrades.findIndex((x) => x.id === t.id);
          if (idx >= 0) {
            const base = updatedTrades[idx];
            let score = base.score ?? base.aiScore ?? base.ai?.score ?? base.signalScore;
            let grade = base.grade ?? base.ai?.grade;
            let tier = base.tier ?? base.ai?.tier;

            if (tier == null) tier = inferTradeTier(base);
            if (grade == null) grade = inferTradeGrade(base);

            if ((score == null || tier == null || grade == null) && base.signalId) {
              const sig = await getSignalById(String(base.signalId));
              if (sig) {
                if (score == null && sig?.score != null) score = sig.score;
                if (grade == null && sig?.grade != null) grade = sig.grade;
                if (tier == null && sig?.tier != null) tier = sig.tier;
              }
            }

            updatedTrades[idx] = {
              ...base,
              realizedPnL: pnl,
              closedAt: base.closedAt ?? nowIso,
              realizedR,
              score: score != null ? Number(score) : base.score,
              grade: grade != null ? String(grade) : base.grade,
              tier: tier != null ? String(tier).toUpperCase() as any : base.tier,
              updatedAt: nowIso,
            };
            changed = true;
            if (pnl < 0) {
              const guardDate = etDateString(new Date());
              try {
                await guardrailsStore.recordLoss(guardDate, nowIso);
              } catch (err) {
                console.error("[manage] guardrail recordLoss failed", { err });
              }
            }

            const aiTier = (t as any)?.ai?.tier ?? (t as any)?.tier;
            const isPaper = (t as any).paper !== false;
            const formattedR =
              realizedR != null ? ` (${realizedR.toFixed(2)}R)` : "";
            const resultLabel = pnl >= 0 ? "gain" : "loss";
            const closeMessage = `${t.side} ${t.ticker} closed with ${resultLabel} ${pnl.toFixed(
              2
            )}${formattedR}`;
            const closedEvent: NotificationEvent = {
              type: "TRADE_CLOSED",
              tradeId: t.id,
              ticker: t.ticker,
              tier: aiTier,
              paper: isPaper,
              title: `Trade closed ${t.ticker}`,
              message: closeMessage,
              dedupeKey: `TRADE_CLOSED:${t.id}`,
              dedupeTtlSec: 86400,
              meta: {
                realizedR,
                realizedPnL: pnl,
                exitPrice,
              },
            };
            await fireNotification(closedEvent);
            if (pnl < 0) {
              const stopEvent: NotificationEvent = {
                type: "STOP_HIT",
                tradeId: t.id,
                ticker: t.ticker,
                tier: aiTier,
                paper: isPaper,
                title: `Stop hit ${t.ticker}`,
                message: `${t.ticker} stopped out for ${pnl.toFixed(2)} loss`,
                dedupeKey: `STOP_HIT:${t.id}`,
                dedupeTtlSec: 86400,
                meta: {
                  realizedPnL: pnl,
                  exitPrice,
                },
              };
              await fireNotification(stopEvent);
            }
          }
        }
      } catch (err) {
        console.error("[manage] failed to compute realized PnL", {
          id: t.id,
          err,
        });
      }
    }

    if (changed) {
      await writeTrades(updatedTrades);
    }

    const openTrades = updatedTrades.filter((t) =>
      ["OPEN", "PENDING", "PARTIAL"].includes((t.status || "").toUpperCase())
    );

    console.log("[manage] openTrades", openTrades);
    console.log("[manage] alpacaPositions", alpacaPositions);

    return NextResponse.json(
      {
        openTrades,
        alpacaPositions,
        autoManagementEnabled: autoEnabled,
        alpacaError: alpacaError ? alpacaError?.message || "Alpaca error" : undefined,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("GET /api/trades/manage error:", err);
    return NextResponse.json(
      {
        ok: false,
        error: "Failed to load management data",
        detail: err?.message ?? String(err),
      },
      { status: 500 }
    );
  }
}

// ─── POST: Trade actions (repair / close / update) ──────────────────

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const action = String(body?.action || "").toLowerCase();
  const tradeId = String(body?.tradeId || "");

  if (!action || !tradeId) {
    return NextResponse.json(
      { ok: false, error: "action and tradeId required" },
      { status: 400 },
    );
  }

  const trades = await readTrades<Trade>();
  const trade = trades.find((t) => t.id === tradeId);
  if (!trade) {
    return NextResponse.json(
      { ok: false, error: "trade not found" },
      { status: 404 },
    );
  }

  const nowIso = new Date().toISOString();

  switch (action) {
    case "repair":
      return handleRepair(trade, trades, nowIso);
    case "close":
      return handleClose(trade, trades, nowIso);
    case "update":
      return handleUpdate(trade, trades, nowIso, body.updates || {});
    default:
      return NextResponse.json(
        { ok: false, error: `unknown action: ${action}` },
        { status: 400 },
      );
  }
}

// ─── Repair: broker-authoritative qty, GTC TIF, flatten on fail ─────

async function handleRepair(trade: Trade, allTrades: Trade[], nowIso: string) {
  const symbol = trade.ticker.toUpperCase();

  // Get broker-authoritative qty
  let brokerPos: any = null;
  try {
    brokerPos = await getPositions(symbol);
  } catch {}
  const brokerQty = Math.abs(Number(brokerPos?.qty ?? 0));

  if (!brokerPos || brokerQty <= 0) {
    return NextResponse.json(
      { ok: false, error: "no_broker_position", symbol },
      { status: 422 },
    );
  }

  const side = (trade.side || "").toUpperCase();
  const stopSide = side === "SHORT" ? "buy" : "sell";
  const entryPrice = Number(trade.entryPrice ?? brokerPos?.avg_entry_price ?? 0);

  let stopPrice = trade.suggestedStopPrice;
  if (!stopPrice || !Number.isFinite(stopPrice)) {
    stopPrice =
      side === "LONG"
        ? Math.round(entryPrice * 0.98 * 100) / 100
        : Math.round(entryPrice * 1.02 * 100) / 100;
  }

  // Normalize stop price
  const tick = tickForEquityPrice(entryPrice);
  const normResult = normalizeStopPrice({
    side: (side as "LONG" | "SHORT") || "LONG",
    entryPrice,
    stopPrice,
    tick,
  });
  if (normResult.ok) stopPrice = normResult.stop;

  try {
    const order = await createOrder({
      symbol,
      qty: String(brokerQty),
      side: stopSide,
      type: "stop",
      stop_price: String(stopPrice),
      time_in_force: "gtc",
    });

    // Update trade in DB
    const idx = allTrades.findIndex((t) => t.id === trade.id);
    if (idx >= 0) {
      allTrades[idx] = {
        ...allTrades[idx],
        protectionStatus: "REPAIRED" as ProtectionStatus,
        protectionVerifiedAt: nowIso,
        protectionIssue: undefined,
        updatedAt: nowIso,
      };
      await writeTrades(allTrades);
    }

    console.log("[manage] repair stop submitted", {
      symbol,
      qty: brokerQty,
      stopPrice,
      orderId: order.id,
      timeInForce: "gtc",
    });

    return NextResponse.json({
      ok: true,
      action: "repair",
      symbol,
      orderId: order.id,
      qty: brokerQty,
      stopPrice,
      timeInForce: "gtc",
    });
  } catch (repairErr: any) {
    console.error("[manage] repair failed", {
      symbol,
      error: repairErr?.message,
    });

    // Flatten on repair fail (gated by env flag)
    if (envFlag("RISK_FLATTEN_ON_REPAIR_FAIL")) {
      try {
        await alpacaRequest({
          method: "DELETE",
          path: `/v2/positions/${encodeURIComponent(symbol)}`,
        });

        await saveCriticalTask({
          incidentCode: "STOP_REPAIR_FAILED",
          symbol,
          severity: "CRITICAL",
          detail: `Repair failed: ${repairErr?.message}; position flattened`,
        }).catch(() => {});

        const idx = allTrades.findIndex((t) => t.id === trade.id);
        if (idx >= 0) {
          allTrades[idx] = {
            ...allTrades[idx],
            status: "CLOSED",
            closedAt: nowIso,
            closeReason: "flatten_repair_fail",
            protectionStatus: "FLATTENED" as ProtectionStatus,
            updatedAt: nowIso,
          };
          await writeTrades(allTrades);
        }

        return NextResponse.json({
          ok: false,
          action: "repair",
          symbol,
          repairError: repairErr?.message,
          flattened: true,
        });
      } catch (flatErr: any) {
        await saveCriticalTask({
          incidentCode: "FLATTEN_FAILED",
          symbol,
          severity: "CRITICAL",
          detail: `Repair AND flatten failed: ${flatErr?.message}`,
        }).catch(() => {});

        return NextResponse.json(
          {
            ok: false,
            action: "repair",
            symbol,
            repairError: repairErr?.message,
            flattenError: flatErr?.message,
          },
          { status: 500 },
        );
      }
    } else {
      // Flatten disabled — emit task and return error
      await saveCriticalTask({
        incidentCode: "STOP_REPAIR_FAILED",
        symbol,
        severity: "CRITICAL",
        detail: `Repair failed: ${repairErr?.message}; flatten disabled`,
      }).catch(() => {});

      return NextResponse.json(
        {
          ok: false,
          action: "repair",
          symbol,
          repairError: repairErr?.message,
          flattened: false,
        },
        { status: 500 },
      );
    }
  }
}

// ─── Close: cancel orders + DELETE position ─────────────────────────

async function handleClose(trade: Trade, allTrades: Trade[], nowIso: string) {
  const symbol = trade.ticker.toUpperCase();

  // Cancel all open orders for this symbol first
  try {
    await alpacaRequest({
      method: "DELETE",
      path: `/v2/orders?symbols=${encodeURIComponent(symbol)}`,
    });
  } catch (err) {
    console.warn("[manage] cancel orders failed (proceeding)", { symbol, err });
  }

  // Close position
  try {
    await alpacaRequest({
      method: "DELETE",
      path: `/v2/positions/${encodeURIComponent(symbol)}`,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, action: "close", symbol, error: err?.message },
      { status: 500 },
    );
  }

  const idx = allTrades.findIndex((t) => t.id === trade.id);
  if (idx >= 0) {
    allTrades[idx] = {
      ...allTrades[idx],
      status: "CLOSED",
      closedAt: nowIso,
      closeReason: "manual_close",
      updatedAt: nowIso,
    };
    await writeTrades(allTrades);
  }

  return NextResponse.json({ ok: true, action: "close", symbol });
}

// ─── Update: DB-only field update ───────────────────────────────────

async function handleUpdate(
  trade: Trade,
  allTrades: Trade[],
  nowIso: string,
  updates: Record<string, any>,
) {
  const idx = allTrades.findIndex((t) => t.id === trade.id);
  if (idx < 0) {
    return NextResponse.json(
      { ok: false, error: "trade not found" },
      { status: 404 },
    );
  }

  // Only allow safe field updates
  const allowed = [
    "suggestedStopPrice",
    "stopSuggestionReason",
    "protectionStatus",
    "protectionIssue",
    "tier",
    "grade",
    "score",
  ];
  const safeUpdates: Record<string, any> = {};
  for (const key of allowed) {
    if (key in updates) safeUpdates[key] = updates[key];
  }

  allTrades[idx] = { ...allTrades[idx], ...safeUpdates, updatedAt: nowIso };
  await writeTrades(allTrades);

  return NextResponse.json({
    ok: true,
    action: "update",
    tradeId: trade.id,
    updated: Object.keys(safeUpdates),
  });
}
