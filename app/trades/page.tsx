"use client";

import { useEffect, useState } from "react";
import { BottomNav } from "@/components/BottomNav";

type TradeStatus = "OPEN" | "CLOSED" | "CANCELLED" | "PARTIAL";

type Side = "LONG" | "SHORT";

type ManagementRule = {
  rMultiple: number;
  percentToClose: number;
};

type ManagementConfig = {
  moveStopToBreakEvenAtR?: number | null;
  autoPartialTakeProfits?: ManagementRule[] | null;
};

export type TradeRow = {
  id: string;
  ticker: string;
  side: Side;
  status: TradeStatus;
  entryPrice: number;
  stopPrice: number;
  targetPrice?: number | null;

  // Sizing
  quantity?: number | null;
  size?: number | null; // fallback for quantity
  oneR?: number | null;
  initialDollarRisk?: number | null;
  initialRiskPerShare?: number | null;

  // Optional extras we won’t assume are always present
  source?: string | null;
  notes?: string | null;
  management?: ManagementConfig | null;

  openedAt?: string | null;
  closedAt?: string | null;

  // Any other fields you might have
  [key: string]: any;
};

type TradesResponse = TradeRow[] | { trades: TradeRow[] };

type TradesSummary = {
  totalTrades: number;
  openTrades: number;
  openRisk: number;
  realizedPnlToday: number;
};

function isWrappedResponse(data: TradesResponse): data is { trades: TradeRow[] } {
  return typeof data === "object" && data !== null && "trades" in data;
}

function normalizeTrades(data: TradesResponse): TradeRow[] {
  const rawTrades = isWrappedResponse(data) ? data.trades : data;

  if (!Array.isArray(rawTrades)) {
    console.warn("Unexpected /api/trades payload shape:", rawTrades);
    return [];
  }

  return rawTrades.map((t: any) => {
    const quantity =
      typeof t.quantity === "number" && t.quantity > 0
        ? t.quantity
        : typeof t.size === "number"
        ? t.size
        : 0;

    const status: TradeStatus =
      t.status === "CLOSED" ||
      t.status === "CANCELLED" ||
      t.status === "PARTIAL"
        ? t.status
        : "OPEN";

    return {
      id: String(t.id ?? ""),
      ticker: String(t.ticker ?? "").toUpperCase(),
      side: (t.side === "SHORT" ? "SHORT" : "LONG") as Side,
      status,
      entryPrice: Number(t.entryPrice ?? 0),
      stopPrice: Number(t.stopPrice ?? 0),
      targetPrice: t.targetPrice != null ? Number(t.targetPrice) : null,
      quantity,
      size: t.size != null ? Number(t.size) : null,
      oneR: t.oneR != null ? Number(t.oneR) : null,
      initialDollarRisk:
        t.initialDollarRisk != null ? Number(t.initialDollarRisk) : null,
      initialRiskPerShare:
        t.initialRiskPerShare != null
          ? Number(t.initialRiskPerShare)
          : null,
      source: t.source ?? null,
      notes: t.notes ?? null,
      management: t.management ?? null,
      openedAt: t.openedAt ?? null,
      closedAt: t.closedAt ?? null,
      ...t,
    };
  });
}

function computeSummary(trades: TradeRow[]): TradesSummary {
  const now = new Date();
  const todayISO = now.toISOString().slice(0, 10); // YYYY-MM-DD

  let openTrades = 0;
  let openRisk = 0;
  let realizedPnlToday = 0;

  for (const t of trades) {
    if (t.status === "OPEN") {
      openTrades += 1;
      if (typeof t.initialDollarRisk === "number") {
        openRisk += t.initialDollarRisk;
      }
    }

    // If you add a realizedPnl field later, we’ll pick it up here.
    const realizedPnl =
      typeof t.realizedPnl === "number"
        ? t.realizedPnl
        : typeof t.realizedPnL === "number"
        ? t.realizedPnL
        : null;

    if (
      t.status === "CLOSED" &&
      realizedPnl != null &&
      t.closedAt &&
      typeof t.closedAt === "string" &&
      t.closedAt.startsWith(todayISO)
    ) {
      realizedPnlToday += realizedPnl;
    }
  }

  return {
    totalTrades: trades.length,
    openTrades,
    openRisk,
    realizedPnlToday,
  };
}

function formatCurrency(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value == null || Number.isNaN(value)) return "—";
  return value.toFixed(digits);
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function statusChipClasses(status: TradeStatus): string {
  switch (status) {
    case "OPEN":
      return "bg-emerald-900/60 text-emerald-300 border border-emerald-500/40";
    case "CLOSED":
      return "bg-slate-800 text-slate-200 border border-slate-500/40";
    case "PARTIAL":
      return "bg-amber-900/60 text-amber-200 border border-amber-500/40";
    case "CANCELLED":
      return "bg-rose-950 text-rose-300 border border-rose-600/50";
    default:
      return "bg-slate-800 text-slate-200 border border-slate-700";
  }
}

function sidePillClasses(side: Side): string {
  return side === "LONG"
    ? "bg-emerald-950 text-emerald-300 border border-emerald-600/60"
    : "bg-rose-950 text-rose-300 border border-rose-600/60";
}

export default function TradesPage() {
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [summary, setSummary] = useState<TradesSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadTrades() {
      try {
        setLoading(true);
        setError(null);

        const res = await fetch("/api/trades", {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
          cache: "no-store",
        });

        if (!res.ok) {
          const text = await res.text();
          console.error("Failed to load trades:", res.status, text);
          if (!cancelled) {
            setError(`Failed to load trades (${res.status})`);
            setTrades([]);
            setSummary(null);
          }
          return;
        }

        const data: TradesResponse = await res.json();
        console.debug("Raw /api/trades payload:", data);
        const normalized = normalizeTrades(data);
        console.debug("Normalized trades:", normalized);

        if (!cancelled) {
          setTrades(normalized);
          setSummary(computeSummary(normalized));
        }
      } catch (err: any) {
        console.error("Error fetching trades:", err);
        if (!cancelled) {
          setError("Failed to load trades (network or parse error)");
          setTrades([]);
          setSummary(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadTrades();

    return () => {
      cancelled = true;
    };
  }, []);

  const hasTrades = trades.length > 0;

  return (
    <>
      <div className="app-page">
        <header className="app-header">
          <div className="app-header-title">Trades</div>
          <div className="app-header-subtitle">All executions &amp; orders</div>
        </header>

        <div className="grid gap-3 rounded-2xl bg-slate-900/70 p-4 shadow-lg shadow-black/40 sm:grid-cols-3 border border-slate-700/60">
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-slate-400">
              Open trades
            </span>
            <span className="text-xl font-semibold">
              {summary ? summary.openTrades : loading ? "…" : 0}
            </span>
            <span className="text-xs text-slate-500">
              {summary ? `${summary.totalTrades} total in log` : ""}
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-slate-400">
              Open risk (∑ 1R)
            </span>
            <span className="text-xl font-semibold">
              {summary ? formatCurrency(summary.openRisk) : loading ? "…" : "—"}
            </span>
            <span className="text-xs text-slate-500">
              Uses initialDollarRisk per open trade.
            </span>
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-slate-400">
              Today&apos;s realized P&amp;L
            </span>
            <span
              className={`text-xl font-semibold ${
                summary && summary.realizedPnlToday > 0
                  ? "text-emerald-400"
                  : summary && summary.realizedPnlToday < 0
                  ? "text-rose-400"
                  : ""
              }`}
            >
              {summary
                ? formatCurrency(summary.realizedPnlToday)
                : loading
                ? "…"
                : "—"}
            </span>
            <span className="text-xs text-slate-500">
              Based on CLOSED trades with a realizedPnl field.
            </span>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-rose-700/70 bg-rose-950/40 px-4 py-3 text-sm text-rose-200">
            {error}
          </div>
        )}

        {!error && loading && (
          <div className="rounded-xl border border-slate-700/70 bg-slate-900/60 px-4 py-3 text-sm text-slate-300">
            Loading trades…
          </div>
        )}

        <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/80 shadow-lg shadow-black/50 table-wrapper">
          <div className="overflow-x-auto">
            <table className="min-w-full border-collapse text-sm">
              <thead className="bg-slate-900/80 border-b border-slate-800">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Symbol
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Side
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Qty
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Entry
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Stop
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Target
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-400">
                    1R
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Status
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Opened
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-400">
                    Notes
                  </th>
                </tr>
              </thead>
              <tbody>
                {!hasTrades && !loading && !error && (
                  <tr>
                    <td
                      className="px-4 py-6 text-center text-slate-400"
                      colSpan={10}
                    >
                      No trades yet.
                    </td>
                  </tr>
                )}

                {trades.map((t) => (
                  <tr
                    key={t.id}
                    className="border-t border-slate-800/80 hover:bg-slate-900/60 transition-colors"
                  >
                    <td className="px-4 py-3 align-middle">
                      <span className="font-semibold tracking-wide">
                        {t.ticker}
                      </span>
                    </td>

                    <td className="px-4 py-3 align-middle">
                      <span
                        className={
                          "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold " +
                          sidePillClasses(t.side)
                        }
                      >
                        {t.side}
                      </span>
                    </td>

                    <td className="px-4 py-3 text-right tabular-nums align-middle">
                      {t.quantity ?? t.size ?? 0}
                    </td>

                    <td className="px-4 py-3 text-right tabular-nums align-middle">
                      {formatNumber(t.entryPrice)}
                    </td>

                    <td className="px-4 py-3 text-right tabular-nums align-middle">
                      {formatNumber(t.stopPrice)}
                    </td>

                    <td className="px-4 py-3 text-right tabular-nums align-middle">
                      {t.targetPrice != null
                        ? formatNumber(t.targetPrice)
                        : "—"}
                    </td>

                    <td className="px-4 py-3 text-right tabular-nums align-middle">
                      {t.oneR != null
                        ? formatCurrency(t.oneR)
                        : t.initialDollarRisk != null
                        ? formatCurrency(t.initialDollarRisk)
                        : "—"}
                    </td>

                    <td className="px-4 py-3 align-middle">
                      <span
                        className={
                          "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium " +
                          statusChipClasses(t.status)
                        }
                      >
                        {t.status}
                      </span>
                    </td>

                    <td className="px-4 py-3 align-middle text-xs text-slate-300">
                      {formatDateTime(t.openedAt ?? null)}
                    </td>

                    <td className="px-4 py-3 align-middle text-xs text-slate-400 max-w-xs truncate">
                      {t.notes || t.source || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
      <BottomNav />
    </>
  );
}
