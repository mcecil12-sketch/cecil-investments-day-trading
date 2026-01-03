"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
} from "recharts";

type PortfolioResp = {
  ok: boolean;
  startingBalance: number;
  currentBalance: number;
  totalPnL: number;
  equityCurve: { date: string; equity: number }[];
  dailyPnL: { date: string; pnl: number }[];
  tradeStats: {
    totalClosedTrades: number;
    winRate: number;
    avgWin: number;
    avgLoss: number;
  };
};

function fmtMoney(n: number) {
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function fmtPct(n: number) {
  if (!Number.isFinite(n)) return "-";
  return (n * 100).toFixed(1) + "%";
}

function fmtNum(n: number) {
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

export default function PerformancePage() {
  const [data, setData] = useState<PortfolioResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    try {
      setLoading(true);
      setErr(null);
      const resp = await fetch("/api/performance/portfolio", { cache: "no-store" });
      const json = (await resp.json()) as PortfolioResp;
      if (!json?.ok) throw new Error("bad_response");
      setData(json);
    } catch (e: any) {
      setErr(e?.message || "failed");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  const equitySeries = useMemo(() => data?.equityCurve ?? [], [data]);
  const pnlSeries = useMemo(() => data?.dailyPnL ?? [], [data]);

  const pnlColor = useMemo(() => {
    const pnl = data?.totalPnL ?? 0;
    return pnl >= 0 ? "text-green-400" : "text-red-400";
  }, [data]);

  return (
    <div className="min-h-screen px-4 pb-28 pt-4">
      <div className="mb-4 flex items-end justify-between">
        <div>
          <div className="text-xl font-semibold tracking-tight">Performance</div>
          <div className="text-sm text-white/60">Portfolio P&amp;L and trends over time</div>
        </div>
        <button
          onClick={load}
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10"
        >
          Refresh
        </button>
      </div>

      {loading && (
        <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-white/70">
          Loading portfolio…
        </div>
      )}

      {!loading && err && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-200">
          Failed to load: {err}
        </div>
      )}

      {!loading && !err && data && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="text-xs text-white/60">Current balance</div>
              <div className="mt-1 text-lg font-semibold">{fmtMoney(data.currentBalance)}</div>
              <div className="mt-1 text-xs text-white/50">Start: {fmtMoney(data.startingBalance)}</div>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="text-xs text-white/60">Total P/L</div>
              <div className={"mt-1 text-lg font-semibold " + pnlColor}>{fmtMoney(data.totalPnL)}</div>
              <div className="mt-1 text-xs text-white/50">
                {data.startingBalance ? fmtPct(data.totalPnL / data.startingBalance) : "-"}
              </div>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="text-xs text-white/60">Win rate</div>
              <div className="mt-1 text-lg font-semibold">{fmtPct(data.tradeStats.winRate)}</div>
              <div className="mt-1 text-xs text-white/50">{data.tradeStats.totalClosedTrades} closed trades</div>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="text-xs text-white/60">Avg win / loss</div>
              <div className="mt-1 text-lg font-semibold">
                {fmtMoney(data.tradeStats.avgWin)} <span className="text-white/30">/</span> {fmtMoney(data.tradeStats.avgLoss)}
              </div>
              <div className="mt-1 text-xs text-white/50">Realized only (closed trades)</div>
            </div>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="mb-2">
                <div className="text-sm font-semibold">Equity curve</div>
                <div className="text-xs text-white/60">Balance over time</div>
              </div>

              <div className="h-64">
                {equitySeries.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-sm text-white/60">
                    No closed trades yet — equity curve will appear after the first realized P&amp;L.
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={equitySeries} margin={{ left: 8, right: 8, top: 8, bottom: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                      <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => String(v)} />
                      <Tooltip formatter={(v: any) => fmtMoney(Number(v))} labelFormatter={(l) => String(l)} />
                      <Line type="monotone" dataKey="equity" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="mb-2">
                <div className="text-sm font-semibold">Daily P&amp;L</div>
                <div className="text-xs text-white/60">Realized P&amp;L by day</div>
              </div>

              <div className="h-64">
                {pnlSeries.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-sm text-white/60">
                    No daily P&amp;L yet — this will populate once trades close.
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={pnlSeries} margin={{ left: 8, right: 8, top: 8, bottom: 8 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                      <YAxis tick={{ fontSize: 12 }} />
                      <Tooltip formatter={(v: any) => fmtMoney(Number(v))} labelFormatter={(l) => String(l)} />
                      <Bar dataKey="pnl" />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold">Notes</div>
                <div className="text-xs text-white/60">
                  This view currently tracks realized P&amp;L from CLOSED trades. Next: unrealized P&amp;L,
                  drawdown, and drilldowns by day/week/trade.
                </div>
              </div>
              <div className="text-xs text-white/50">Updated {new Date().toLocaleTimeString()}</div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="rounded-lg border border-white/10 bg-black/20 p-3">
                <div className="text-[11px] text-white/60">Closed trades</div>
                <div className="mt-1 text-sm font-semibold">{fmtNum(data.tradeStats.totalClosedTrades)}</div>
              </div>
              <div className="rounded-lg border border-white/10 bg-black/20 p-3">
                <div className="text-[11px] text-white/60">Daily P&amp;L points</div>
                <div className="mt-1 text-sm font-semibold">{fmtNum(pnlSeries.length)}</div>
              </div>
              <div className="rounded-lg border border-white/10 bg-black/20 p-3">
                <div className="text-[11px] text-white/60">Equity points</div>
                <div className="mt-1 text-sm font-semibold">{fmtNum(equitySeries.length)}</div>
              </div>
              <div className="rounded-lg border border-white/10 bg-black/20 p-3">
                <div className="text-[11px] text-white/60">Refresh cadence</div>
                <div className="mt-1 text-sm font-semibold">60s</div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
