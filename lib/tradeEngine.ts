// lib/tradeEngine.ts
//
// Auto-management engine that:
// - Reads your existing Trade model (from data/trades.json via /api/trades)
// - Computes current R for each open trade
// - Marks partial targets (virtual) based on management.autoPartialTakeProfits
// - Suggests recommended actions
//
// IMPORTANT: This DOES NOT write back to the trades file.
// It returns an engine "view" of trades for the UI.

export type SourceTradeStatus = "OPEN" | "CLOSED";
export type SourceTradeSide = "LONG" | "SHORT";

export interface SourceTrade {
  id: string;
  ticker: string;
  side: SourceTradeSide;
  size: number;
  entryPrice: number;
  stopPrice?: number;
  targetPrice?: number;

  openedAt: string;
  closedAt?: string;
  status: SourceTradeStatus;
  notes?: string;
  realizedPnL?: number;

  initialRiskPerShare?: number;
  initialDollarRisk?: number;
  maxRReached?: number;

  management?: {
    moveStopToBreakEvenAtR?: number | null;
    autoPartialTakeProfits?: {
      rMultiple: number;
      percentToClose: number;
    }[];
  };
}

// Engine-facing “view” type
export type EngineSide = "long" | "short";

export interface EnginePartialPlan {
  rMultiple: number;
  percent: number;
  label?: string;
  filled?: boolean; // virtual only
}

export interface EngineTrade {
  id: string;
  symbol: string;
  side: EngineSide;
  entryPrice: number;
  stopPrice: number;
  size: number;
  currentSize: number;
  status: "open" | "closed";

  createdAt: string;
  closedAt?: string;

  riskPerShare: number;
  riskAmount: number;

  breakEvenMoved?: boolean;
  partialPlan?: EnginePartialPlan[];
  hitTargets?: number[];
  currentR?: number;
  lastPrice?: number;

  realizedPnL?: number;
  realizedR?: number;

  recommendedActions?: string[];
  engineLog?: string[];
}

export interface AutoManageSummary {
  totalTrades: number;
  openTrades: number;
  updatedTrades: number;
  symbolCount: number;
  maxR?: number;
  minR?: number;
}

export interface LatestQuote {
  symbol: string;
  bid_price: number;
  ask_price: number;
  bid_size: number;
  ask_size: number;
  timestamp: string;
}

// ---- Price fetch hook: you must implement getLatestQuote in lib/alpaca.ts ----
import { getLatestQuote } from "@/lib/alpaca";

// ---- Helpers ----

function computeRiskPerShare(
  side: EngineSide,
  entry: number,
  stop: number
): number {
  if (side === "long") {
    return Math.max(entry - stop, 0);
  }
  return Math.max(stop - entry, 0);
}

function computeCurrentR(
  side: EngineSide,
  entry: number,
  stop: number,
  currentPrice: number
): number {
  const rps = computeRiskPerShare(side, entry, stop);
  if (rps === 0) return 0;

  if (side === "long") {
    return (currentPrice - entry) / rps;
  } else {
    return (entry - currentPrice) / rps;
  }
}

function srcSideToEngine(side: SourceTradeSide): EngineSide {
  return side === "SHORT" ? "short" : "long";
}

function srcStatusToEngine(status: SourceTradeStatus): "open" | "closed" {
  return status === "OPEN" ? "open" : "closed";
}

function buildPartialPlanFromManagement(
  mgmt?: SourceTrade["management"]
): EnginePartialPlan[] | undefined {
  if (!mgmt || !mgmt.autoPartialTakeProfits) return undefined;
  if (mgmt.autoPartialTakeProfits.length === 0) return undefined;

  return mgmt.autoPartialTakeProfits.map((p) => ({
    rMultiple: p.rMultiple,
    percent: p.percentToClose,
    label: `Take ${(p.percentToClose * 100).toFixed(0)}% at ${p.rMultiple}R`,
    filled: false,
  }));
}

// ---- Engine core ----

export async function runAutoManagement(
  sourceTrades: SourceTrade[]
): Promise<{ trades: EngineTrade[]; summary: AutoManageSummary }> {
  const openSource = sourceTrades.filter(
    (t) => t.status === "OPEN" && t.size > 0
  );

  if (openSource.length === 0) {
    return {
      trades: [],
      summary: {
        totalTrades: sourceTrades.length,
        openTrades: 0,
        updatedTrades: 0,
        symbolCount: 0,
      },
    };
  }

  const uniqueSymbols = Array.from(
    new Set(openSource.map((t) => t.ticker.toUpperCase()))
  );

  const priceMap = new Map<string, number>();

  for (const symbol of uniqueSymbols) {
    try {
      const quote = await getLatestQuote(symbol);
      const mid =
        quote.bid_price && quote.ask_price
          ? (quote.bid_price + quote.ask_price) / 2
          : quote.ask_price || quote.bid_price;
      if (!mid || mid <= 0) {
        console.warn("[tradeEngine] No valid price for", symbol, quote);
        continue;
      }
      priceMap.set(symbol, mid);
    } catch (err) {
      console.error("[tradeEngine] Failed to fetch quote for", symbol, err);
    }
  }

  let updatedTrades = 0;
  let maxR: number | undefined;
  let minR: number | undefined;

  const engineTrades: EngineTrade[] = openSource.map((src) => {
    const symbol = src.ticker.toUpperCase();
    const side = srcSideToEngine(src.side);
    const status = srcStatusToEngine(src.status);
    const createdAt = src.openedAt;

    const stopPrice = src.stopPrice ?? src.entryPrice; // guard
    const riskPerShare =
      src.initialRiskPerShare && src.initialRiskPerShare > 0
        ? src.initialRiskPerShare
        : computeRiskPerShare(side, src.entryPrice, stopPrice);

    const riskAmount =
      src.initialDollarRisk && src.initialDollarRisk > 0
        ? src.initialDollarRisk
        : riskPerShare * src.size;

    const engine: EngineTrade = {
      id: src.id,
      symbol,
      side,
      entryPrice: src.entryPrice,
      stopPrice,
      size: src.size,
      currentSize: src.size,
      status,
      createdAt,
      closedAt: src.closedAt,
      riskPerShare,
      riskAmount,
      partialPlan: buildPartialPlanFromManagement(src.management),
      hitTargets: [],
      currentR: 0,
      lastPrice: undefined,
      realizedPnL: src.realizedPnL,
      realizedR:
        riskAmount !== 0 && src.realizedPnL !== undefined
          ? src.realizedPnL / riskAmount
          : undefined,
      recommendedActions: [],
      engineLog: [],
    };

    // Try to get price
    const px = priceMap.get(symbol);
    if (!px) {
      engine.engineLog?.push("No live price available; skipped R calc.");
      return engine;
    }

    const currentR = computeCurrentR(
      side,
      engine.entryPrice,
      engine.stopPrice,
      px
    );
    engine.currentR = currentR;
    engine.lastPrice = px;

    if (maxR === undefined || currentR > maxR) maxR = currentR;
    if (minR === undefined || currentR < minR) minR = currentR;

    // Break-even suggestion
    const beR = src.management?.moveStopToBreakEvenAtR;
    if (beR != null && currentR >= beR) {
      engine.breakEvenMoved = true; // "should be" at breakeven now
      engine.recommendedActions?.push("move-stop-to-breakeven");
      engine.engineLog?.push(
        `Hit ≥ ${beR}R (currentR=${currentR.toFixed(
          2
        )}). Recommend moving stop to breakeven.`
      );
    }

    // Partial targets suggestions
    if (engine.partialPlan) {
      for (const p of engine.partialPlan) {
        if (currentR >= p.rMultiple) {
          engine.hitTargets?.push(p.rMultiple);
          const percentLabel = `${(p.percent * 100).toFixed(0)}%`;
          const msg =
            p.label ||
            `Take ${percentLabel} at ${p.rMultiple}R (currentR=${currentR.toFixed(
              2
            )})`;
          engine.recommendedActions?.push(
            `partial-${p.rMultiple}R-${percentLabel}`
          );
          engine.engineLog?.push(msg);
        }
      }
    }

    // Optional guardrails
    if (currentR >= 4) {
      engine.recommendedActions?.push("consider-full-exit-at-4R");
    }
    if (currentR <= -1) {
      engine.recommendedActions?.push("consider-stop-out-at--1R");
    }

    updatedTrades += 1;
    return engine;
  });

  const summary: AutoManageSummary = {
    totalTrades: sourceTrades.length,
    openTrades: openSource.length,
    updatedTrades,
    symbolCount: priceMap.size,
    maxR,
    minR,
  };

  return { trades: engineTrades, summary };
}
