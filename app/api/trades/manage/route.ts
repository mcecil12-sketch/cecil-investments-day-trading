import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getPositions, getOrder, replaceOrder } from "@/lib/alpaca";
import { appendActivity } from "@/lib/activity";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import { etDateString } from "@/lib/autoEntry/guardrails";
import * as guardrailsStore from "@/lib/autoEntry/guardrailsStore";

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
  const newStop = trade.suggestedStopPrice;
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
        if (nextStatus === "CLOSED" && t.alpacaOrderId && !t.realizedPnL) {
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
            console.log("[manage] stop suggestion BE", {
              id: t.id,
              ticker: t.ticker,
              suggestedStopPrice,
            });
          }
          if (unrealizedR != null && unrealizedR >= 2 && oneRVal > 0) {
            const lockIn = t.side.toUpperCase() === "LONG"
              ? entry + oneRVal / t.size
              : entry - oneRVal / t.size;
            suggestedStopPrice = lockIn;
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
            updatedTrades[idx] = {
              ...updatedTrades[idx],
              realizedPnL: pnl,
              realizedR,
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
