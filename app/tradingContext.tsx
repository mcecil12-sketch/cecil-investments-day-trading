"use client";

import React, {
  createContext,
  useContext,
  useMemo,
  useState,
  useEffect,
  ReactNode,
} from "react";
import { computeRiskPerShare } from "../lib/risk";

export type TradeStatus = "OPEN" | "CLOSED";
export type TradeSide = "LONG" | "SHORT";

export interface Trade {
  id: string;
  ticker: string;
  side: TradeSide;
  size: number;
  entryPrice: number;
  stopPrice?: number;
  targetPrice?: number;
  oneR?: number;

  openedAt: string;
  closedAt?: string;
  status: TradeStatus;
  notes?: string;
  realizedPnL?: number;

  // --- R-based management fields ---
  initialRiskPerShare?: number; // |entry - stop| at entry
  initialDollarRisk?: number;   // size * initialRiskPerShare
  maxRReached?: number;         // best R multiple seen so far

  management?: {
    moveStopToBreakEvenAtR?: number | null;
    autoPartialTakeProfits?: {
      rMultiple: number;
      percentToClose: number; // 0–100
    }[];
  };
}

export interface TradingSettings {
  accountSize: number;      // $
  riskPerTradePct: number;  // % of account
  oneR: number;             // $ per R
  dailyMaxLossR: number;    // max loss per day in R

  // global defaults for management
  defaultMoveStopToBreakEvenAtR?: number | null;
  defaultFirstPartialAtR?: number | null;
  defaultFirstPartialPct?: number | null; // 0–100
}

export interface TradingContextType {
  trades: Trade[];
  addTrade(trade: Trade): void;
  closeTrade(id: string, realizedPnL: number): void;
  dailyPnL: number;
  settings: TradingSettings;
  updateSettings(partial: Partial<TradingSettings>): void;
  updateTrade(id: string, updates: Partial<Trade>): void;
}

const TradingContext = createContext<TradingContextType | undefined>(
  undefined
);

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

interface TradingProviderProps {
  children: ReactNode;
}

export const TradingProvider: React.FC<TradingProviderProps> = ({
  children,
}) => {
  const initialAccountSize = 25_000;
  const initialRiskPct = 1;
  const initialOneR = initialAccountSize * (initialRiskPct / 100);

  const [trades, setTrades] = useState<Trade[]>([]);

  const [settings, setSettings] = useState<TradingSettings>({
    accountSize: initialAccountSize,
    riskPerTradePct: initialRiskPct,
    oneR: initialOneR, // derived
    dailyMaxLossR: 3,
    defaultMoveStopToBreakEvenAtR: 1,
    defaultFirstPartialAtR: 2,
    defaultFirstPartialPct: 50,
  });

  // 🔄 Load trades from DB on first mount
  useEffect(() => {
    async function loadTrades() {
      try {
        const res = await fetch("/api/trades");
        if (!res.ok) {
          console.error("Failed to load trades from DB");
          return;
        }
        const data = await res.json();
        const dbTrades = (data.trades ?? []) as any[];

        const mapped: Trade[] = dbTrades.map((t) => ({
          id: t.id,
          ticker: t.ticker,
          side: t.side,
          size: t.size,
          entryPrice: t.entryPrice,
          stopPrice: t.stopPrice ?? undefined,
          targetPrice: t.targetPrice ?? undefined,
          openedAt: new Date(t.openedAt).toISOString(),
          closedAt: t.closedAt ? new Date(t.closedAt).toISOString() : undefined,
          status: t.status,
          notes: t.notes ?? undefined,
          realizedPnL: t.realizedPnL ?? undefined,
          initialRiskPerShare: t.initialRiskPerShare ?? undefined,
          initialDollarRisk: t.initialDollarRisk ?? undefined,
          maxRReached: t.maxRReached ?? undefined,
          management: t.management ?? undefined,
        }));

        setTrades(mapped);
      } catch (err) {
        console.error("Error loading trades from DB", err);
      }
    }

    loadTrades();
  }, []);

  const updateSettings = (partial: Partial<TradingSettings>) => {
    setSettings((prev) => {
      const next: TradingSettings = { ...prev, ...partial };
      const { accountSize, riskPerTradePct } = next;
      const oneR = accountSize * (riskPerTradePct / 100);
      next.oneR = oneR;
      return next;
    });
    // (You could also persist settings in DB later if you want)
  };

  // Helper to persist to /api/trades in the background
  async function persistTrade(trade: Trade) {
    try {
      await fetch("/api/trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(trade),
      });
    } catch (err) {
      console.error("Failed to persist trade", err);
    }
  }

  async function persistTradePatch(id: string, updates: Partial<Trade>) {
    try {
      await fetch("/api/trades", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, updates }),
      });
    } catch (err) {
      console.error("Failed to patch trade", err);
    }
  }

  const addTrade = (trade: Trade) => {
    setTrades((prev) => {
      const riskPerShare =
        trade.initialRiskPerShare ??
        computeRiskPerShare(trade.entryPrice, trade.stopPrice);
      const initialDollarRisk =
        trade.initialDollarRisk ??
        (riskPerShare && trade.size ? riskPerShare * trade.size : undefined);

      const enriched: Trade = {
        ...trade,
        initialRiskPerShare: riskPerShare || undefined,
        initialDollarRisk,
        management: {
          moveStopToBreakEvenAtR:
            trade.management?.moveStopToBreakEvenAtR ??
            settings.defaultMoveStopToBreakEvenAtR ??
            1,
          autoPartialTakeProfits:
            trade.management?.autoPartialTakeProfits ??
            (settings.defaultFirstPartialAtR &&
            settings.defaultFirstPartialPct
              ? [
                  {
                    rMultiple: settings.defaultFirstPartialAtR,
                    percentToClose: settings.defaultFirstPartialPct,
                  },
                ]
              : []),
        },
      };

      // fire-and-forget persistence
      void persistTrade(enriched);

      return [...prev, enriched];
    });
  };

  const updateTrade = (id: string, updates: Partial<Trade>) => {
    setTrades((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...updates } : t))
    );
    void persistTradePatch(id, updates);
  };

  const closeTrade = (id: string, realizedPnL: number) => {
    const nowIso = new Date().toISOString();
    const updates: Partial<Trade> = {
      status: "CLOSED",
      realizedPnL,
      closedAt: nowIso,
    };

    setTrades((prev) =>
      prev.map((t) =>
        t.id === id
          ? {
              ...t,
              ...updates,
            }
          : t
      )
    );
    void persistTradePatch(id, updates);
  };

  const dailyPnL = useMemo(() => {
    if (!trades.length) return 0;
    const todayStart = startOfDay(new Date());

    return trades.reduce((sum, t) => {
      if (t.status !== "CLOSED") return sum;
      if (t.realizedPnL == null) return sum;
      if (!t.closedAt) return sum;

      const closedDate = new Date(t.closedAt);
      if (startOfDay(closedDate).getTime() !== todayStart.getTime()) {
        return sum;
      }

      return sum + t.realizedPnL;
    }, 0);
  }, [trades]);

  const value: TradingContextType = {
    trades,
    addTrade,
    closeTrade,
    dailyPnL,
    settings,
    updateSettings,
    updateTrade,
  };

  return (
    <TradingContext.Provider value={value}>
      {children}
    </TradingContext.Provider>
  );
};

export const useTrading = (): TradingContextType => {
  const ctx = useContext(TradingContext);
  if (!ctx) {
    throw new Error("useTrading must be used within a TradingProvider");
  }
  return ctx;
};
