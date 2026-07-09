"use client";

import React, { useEffect, useMemo, useState } from "react";

type TradeSide = "LONG" | "SHORT" | string;
type TradeStatus = "OPEN" | "CLOSED" | string;

type Trade = {
  id: string;
  ticker: string;
  side: TradeSide;
  size: number;
  entryPrice: number;
  stopPrice?: number;
  targetPrice?: number;
  openedAt: string;
  closedAt?: string;
  status: TradeStatus;
  realizedPnL?: number;
  realizedR?: number;
  source?: string;
};

type TradesResponse = {
  trades?: Trade[];
};

type PlaybookRow = {
  source: string;
  total: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgR: number | null;
  bestR: number | null;
  worstR: number | null;
  totalPnL: number;
};

export default function PlaybookPage() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/trades");
        if (!res.ok) throw new Error(`Failed to load trades (${res.status})`);
        const data: TradesResponse = await res.json();
        if (!cancelled) setTrades(data.trades ?? []);
      } catch (err: any) {
        if (!cancelled) setError(err?.message || "Failed to load trades");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const playbooks = useMemo<PlaybookRow[]>(() => {
    const bySource = new Map<string, Trade[]>();
    trades.forEach((t) => {
      const key = t.source || "Unknown";
      if (!bySource.has(key)) bySource.set(key, []);
      bySource.get(key)!.push(t);
    });

    const rows: PlaybookRow[] = [];
    bySource.forEach((list, source) => {
      const closed = list.filter((t) => (t.status || "").toUpperCase() === "CLOSED");
      const wins = closed.filter((t) => (t.realizedPnL ?? 0) > 0).length;
      const losses = closed.filter((t) => (t.realizedPnL ?? 0) < 0).length;
      const realizedRs = closed
        .map((t) => t.realizedR)
        .filter((v): v is number => typeof v === "number");
      const avgR =
        realizedRs.length > 0
          ? realizedRs.reduce((s, v) => s + v, 0) / realizedRs.length
          : null;
      const bestR = realizedRs.length ? Math.max(...realizedRs) : null;
      const worstR = realizedRs.length ? Math.min(...realizedRs) : null;
      const totalPnL = closed.reduce((sum, t) => sum + (t.realizedPnL ?? 0), 0);
      const winRate = wins + losses > 0 ? (wins / (wins + losses)) * 100 : null;

      rows.push({
        source,
        total: list.length,
        wins,
        losses,
        winRate,
        avgR,
        bestR,
        worstR,
        totalPnL,
      });
    });

    return rows.sort((a, b) => b.totalPnL - a.totalPnL);
  }, [trades]);

  return (
    <div className="auto bg-[var(--ci-bg)] text-[var(--ci-text)]">
      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        <h1 className="text-lg md:text-xl font-semibold tracking-tight">Playbook performance</h1>
        {loading && <p className="muted-text">Loading trades…</p>}
        {error && (
          <p className="muted-text" style={{ color: "#ef4444" }}>
            {error}
          </p>
        )}
        {!loading && !playbooks.length && <p className="empty-text">No trades yet.</p>}

        {playbooks.length > 0 && (
          <div className="grid gap-4 md:grid-cols-2">
            {playbooks.map((pb) => (
              <div
                key={pb.source}
                className="bg-[var(--ci-card)] border border-[var(--ci-border)] rounded-xl p-4 md:p-5 shadow-[0_0_12px_rgba(255,255,255,0.03)] space-y-2"
              >
                <div className="text-base font-semibold text-[var(--ci-text)]">
                  {pb.source}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-[var(--ci-text-muted)] text-xs uppercase tracking-wide">
                      Trades
                    </div>
                    <div className="text-[var(--ci-accent)] text-xl font-light">
                      {pb.total}
                    </div>
                  </div>
                  <div>
                    <div className="text-[var(--ci-text-muted)] text-xs uppercase tracking-wide">
                      Wins
                    </div>
                    <div className="text-[var(--ci-accent)] text-xl font-light">
                      {pb.wins}
                    </div>
                  </div>
                  <div>
                    <div className="text-[var(--ci-text-muted)] text-xs uppercase tracking-wide">
                      Win %
                    </div>
                    <div className="text-[var(--ci-accent)] text-xl font-light">
                      {pb.winRate != null ? `${pb.winRate.toFixed(1)}%` : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-[var(--ci-text-muted)] text-xs uppercase tracking-wide">
                      Avg R
                    </div>
                    <div className="text-[var(--ci-accent)] text-xl font-light">
                      {pb.avgR != null ? pb.avgR.toFixed(2) : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-[var(--ci-text-muted)] text-xs uppercase tracking-wide">
                      Best R
                    </div>
                    <div className="text-[var(--ci-accent)] text-xl font-light">
                      {pb.bestR != null ? pb.bestR.toFixed(2) : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-[var(--ci-text-muted)] text-xs uppercase tracking-wide">
                      Worst R
                    </div>
                    <div className="text-[var(--ci-accent)] text-xl font-light">
                      {pb.worstR != null ? pb.worstR.toFixed(2) : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-[var(--ci-text-muted)] text-xs uppercase tracking-wide">
                      Total PnL
                    </div>
                    <div
                      className={`text-xl font-light ${
                        pb.totalPnL >= 0 ? "value-positive" : "value-negative"
                      }`}
                    >
                      ${pb.totalPnL.toFixed(2)}
                    </div>
                    <div className={pb.totalPnL >= 0 ? "pill-result positive" : "pill-result negative"}>
                      {pb.totalPnL >= 0 ? "Net winner" : "Net loser"}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
