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

type DrillRange = "today" | "week" | "month" | "all";

type TradesResp = { ok: boolean; range: DrillRange; count: number; trades: any[] };
type DailyResp = { ok: boolean; range: DrillRange; daily: { date: string; pnl: number }[] };

type PortfolioResp = {
  ok: boolean;
  startingBalance: number;
  currentBalance: number;
  totalPnL: number;
  realizedPnL?: number;
  unrealizedPnL?: number;
  positionsCount?: number;
  maxDrawdown?: number;
  equityCurve: { t: string; equity: number }[];
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
  const [range, setRange] = useState<DrillRange>("week");
  const [drillTrades, setDrillTrades] = useState<any[]>([]);
  const [drillDaily, setDrillDaily] = useState<{ date: string; pnl: number }[]>([]);

    async function loadDrill(r: DrillRange) {
    try {
      const [tr, dr] = await Promise.all([
        fetch(`/api/performance/trades?range=${r}`, { cache: "no-store" }),
        fetch(`/api/performance/daily?range=${r}`, { cache: "no-store" }),
      ]);
      const tj = (await tr.json()) as TradesResp;
      const dj = (await dr.json()) as DailyResp;
      if (tj?.ok) setDrillTrades(tj.trades || []);
      if (dj?.ok) setDrillDaily(dj.daily || []);
    } catch {
      // non-fatal
    }
  }

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
    loadDrill(range);
    const t = setInterval(() => {
      load();
      loadDrill(range);
    }, 60_000);
    return () => clearInterval(t);
  }, [range]);

  const equitySeries = useMemo(() => (data?.equityCurve ?? []).map((p) => ({ date: (p as any).date ?? (p as any).t, equity: (p as any).equity })), [data]);
    const pnlSeries = useMemo(() => drillDaily ?? [], [drillDaily]);

  const pnlColor = useMemo(() => {
    const pnl = data?.totalPnL ?? 0;
    return pnl >= 0 ? "text-green-400" : "text-red-400";
  }, [data]);

  return (
    <div className="min-h-screen px-4 pb-28 pt-4">
      <div className="mb-4 flex items-end justify-between">
        <div>
          <div className="text-xl font-semibold tracking-tight">Performance</div>

      <div className="mb-3 flex items-center gap-2">
        {(["today","week","month","all"] as DrillRange[]).map((r) => (
          <button
            key={r}
            onClick={() => {
              setRange(r);
              loadDrill(r);
            }}
            className={
              "rounded-lg border px-3 py-1.5 text-sm " +
              (range === r
                ? "border-white/20 bg-white/10 text-white"
                : "border-white/10 bg-white/5 text-white/70 hover:bg-white/10")
            }
          >
            {r === "today" ? "Today" : r === "week" ? "Week" : r === "month" ? "Month" : "All"}
          </button>
        ))}
      </div>
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
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
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
              <div className="text-xs text-white/60">Realized P&amp;L</div>
              <div className="mt-1 text-lg font-semibold">{fmtMoney((data.realizedPnL ?? 0) as number)}</div>
              <div className="mt-1 text-xs text-white/50">Closed trades only</div>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="text-xs text-white/60">Unrealized P&amp;L</div>
              <div className={"mt-1 text-lg font-semibold " + ((data.unrealizedPnL ?? 0) >= 0 ? "text-green-400" : "text-red-400")}>
                {fmtMoney((data.unrealizedPnL ?? 0) as number)}
              </div>
              <div className="mt-1 text-xs text-white/50">Open positions</div>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="text-xs text-white/60">Open positions</div>
              <div className="mt-1 text-lg font-semibold">{fmtNum((data.positionsCount ?? 0) as number)}</div>
              <div className="mt-1 text-xs text-white/50">From Alpaca</div>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="text-xs text-white/60">Max drawdown</div>
              <div className="mt-1 text-lg font-semibold">{fmtMoney((data.maxDrawdown ?? 0) as number)}</div>
              <div className="mt-1 text-xs text-white/50">Equity curve</div>
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
                    Equity curve will expand as trades close. Current view includes a live equity snapshot.
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
            <div className="mb-2 flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold">Trades</div>
                <div className="text-xs text-white/60">Closed trades (realized) — range: {range}</div>
              </div>
              <div className="text-xs text-white/50">{drillTrades.length} rows</div>
            </div>

            {drillTrades.length === 0 ? (
              <div className="rounded-lg border border-white/10 bg-black/20 p-3 text-sm text-white/60">
                No closed trades in this range yet.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="text-xs text-white/60">
                    <tr>
                      <th className="py-2 pr-3">Ticker</th>
                      <th className="py-2 pr-3">Side</th>
                      <th className="py-2 pr-3">Closed</th>
                      <th className="py-2 pr-3">P/L</th>
                      <th className="py-2 pr-3">R</th>
                      <th className="py-2 pr-3">Source</th>
                      <th className="py-2 pr-3">Paper</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drillTrades.map((t: any) => (
                      <tr key={t.id} className="border-t border-white/10">
                        <td className="py-2 pr-3 font-semibold">{t.ticker}</td>
                        <td className="py-2 pr-3">{t.side}</td>
                        <td className="py-2 pr-3 text-white/70">{t.closedAt ? new Date(t.closedAt).toLocaleString() : "-"}</td>
                        <td className={"py-2 pr-3 " + ((t.realizedPnL ?? 0) >= 0 ? "text-green-400" : "text-red-400")}>
                          {fmtMoney(Number(t.realizedPnL ?? 0))}
                        </td>
                        <td className="py-2 pr-3 text-white/70">{t.realizedR == null ? "-" : fmtNum(Number(t.realizedR))}</td>
                        <td className="py-2 pr-3 text-white/70">{t.source ?? "-"}</td>
                        <td className="py-2 pr-3 text-white/70">{t.paper == null ? "-" : String(Boolean(t.paper))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>


          <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold">Notes</div>
                <div className="text-xs text-white/60">
                  This view includes live unrealized P&amp;L (Alpaca positions) plus realized P&amp;L from CLOSED trades. Next: drilldowns by day/week/trade.
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
