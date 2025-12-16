"use client";

export const dynamic = "force-dynamic";

import React, { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useTrading } from "@/tradingContext";
import { AiHealthPill } from "@/components/performance/AiHealthPill";
import { IntradayFunnel } from "@/components/performance/IntradayFunnel";

type Stats = {
  totalTrades?: number;
  wins?: number;
  losses?: number;
  breakeven?: number;
  totalRealizedPnL?: number;
  maxDrawdown?: number;
  avgRealizedR?: number | null;
  bestR?: number | null;
  worstR?: number | null;
  autoStopsAppliedToday?: number;
};

type SettingsData = {
  maxTradesPerDay?: number;
};

function StatPill(props: {
  label: string;
  value: React.ReactNode;
  tone?: "neutral" | "positive" | "negative";
}) {
  const { label, value, tone = "neutral" } = props;

  const toneClass =
    tone === "positive"
      ? "value-positive"
      : tone === "negative"
      ? "value-negative"
      : "text-slate-100";

  return (
    <div className="flex flex-col rounded-2xl border border-slate-800/80 bg-slate-900/70 px-3 py-2 min-w-[110px]">
      <span className="text-[10px] uppercase tracking-wide text-slate-400">
        {label}
      </span>
      <span className={`mt-0.5 text-sm font-semibold ${toneClass}`}>
        {value}
      </span>
    </div>
  );
}

function StatTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
}) {
  return (
    <div className="bg-[var(--ci-card)] border border-[var(--ci-border)] rounded-xl p-4 md:p-6 shadow-[0_0_12px_rgba(255,255,255,0.03)] space-y-1">
      <div className="text-[var(--ci-text-muted)] text-xs uppercase tracking-wide">
        {label}
      </div>
      <div className="text-xl md:text-2xl font-semibold text-slate-50">
        {value}
      </div>
      {detail && (
        <div className="text-[var(--ci-text-muted)] text-xs">{detail}</div>
      )}
    </div>
  );
}

export default function PerformancePage() {
  const { settings, dailyPnL } = useTrading();
  const [stats, setStats] = useState<Stats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [settingsData, setSettingsData] = useState<SettingsData | null>(null);

  const oneR = settings.oneR;
  const dailyMaxLossR = settings.dailyMaxLossR;
  const dailyMaxLossDollar = dailyMaxLossR * oneR;

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch("/api/trades/summary", {
        cache: "no-store",
        next: { revalidate: 0 },
      });
      if (!res.ok) throw new Error(`Stats failed (${res.status})`);
      const data = await res.json();
      setStats(data?.stats ?? null);
      setStatsError(null);
    } catch (err: any) {
      console.error("[performance] stats load failed", err);
      setStatsError(err?.message || "Stats unavailable");
    }
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/settings", {
          cache: "no-store",
          next: { revalidate: 0 },
        });
        if (!res.ok) throw new Error("Failed to load settings");
        const data = await res.json();
        if (!cancelled) setSettingsData(data?.settings ?? null);
      } catch (err) {
        console.error("[performance] load settings failed", err);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const lossUsedDollar = dailyPnL < 0 ? Math.abs(dailyPnL) : 0;
  const lossUsedR = oneR > 0 && lossUsedDollar > 0 ? lossUsedDollar / oneR : 0;
  const remainingR = Math.max(dailyMaxLossR - lossUsedR, 0);
  const blockedForDay = lossUsedR >= dailyMaxLossR;

  const todayPnlRaw = dailyPnL;
  const netRRaw = oneR > 0 ? todayPnlRaw / oneR : 0;
  const tradesToday = stats?.totalTrades ?? 0;
  const dailyTradeLimit = settingsData?.maxTradesPerDay ?? "—";
  const remainingRiskDollarFormatted = `$${Math.max(
    dailyMaxLossDollar - lossUsedDollar,
    0
  ).toFixed(0)}`;

  const netPnl = stats?.totalRealizedPnL ?? 0;
  const netR = stats?.avgRealizedR ?? 0;

  const netSentiment =
    netPnl > 0.01 ? "Net winner" : netPnl < -0.01 ? "Net loser" : "Flat";

  const netSentimentClass =
    netPnl > 0.01
      ? "value-positive"
      : netPnl < -0.01
      ? "value-negative"
      : "text-slate-200";

  const todayPnlDisplay = `$${todayPnlRaw.toFixed(2)}`;
  const netRDisplay = oneR > 0 ? `${netRRaw.toFixed(2)}R` : "—";
  const tradesTodayDisplay = `${tradesToday} / ${dailyTradeLimit}`;
  const remainingRiskDisplay = `${remainingR.toFixed(
    1
  )}R · ${remainingRiskDollarFormatted}`;
  const statusDisplay = blockedForDay
    ? "Daily limit hit"
    : dailyPnL > 0
    ? "Green day so far"
    : dailyPnL < 0
    ? "Drawdown · stay selective"
    : "Flat";

  return (
    <>
      <div className="app-page pb-20">
        <header className="mb-4">
          <div className="flex items-center justify-between mb-2">
            <div>
              <h1 className="text-sm font-semibold text-slate-50">
                Performance
              </h1>
              <p className="text-[11px] text-slate-400">
                Paper account session summary
              </p>
            </div>
            <Link
              href="/today"
              className="text-[11px] text-slate-400 underline-offset-2 hover:text-slate-200"
            >
              Back to Today
            </Link>
          </div>

          {/* Session summary pills (mirrors Today header) */}
          <div className="flex flex-wrap gap-2">
            <StatPill
              label="Today P&L"
              value={todayPnlDisplay}
              tone={
                todayPnlRaw > 0
                  ? "positive"
                  : todayPnlRaw < 0
                  ? "negative"
                  : "neutral"
              }
            />
            <StatPill
              label="Net R"
              value={netRDisplay}
              tone={
                netRRaw > 0
                  ? "positive"
                  : netRRaw < 0
                  ? "negative"
                  : "neutral"
              }
            />
            <StatPill label="Trades" value={tradesTodayDisplay} />
            <StatPill
              label="Risk left"
              value={remainingRiskDisplay}
              tone={remainingR <= 0 ? "negative" : "neutral"}
            />
            <StatPill
              label="Status"
              value={statusDisplay}
              tone={
                statusDisplay === "Daily limit hit"
                  ? "negative"
                  : statusDisplay === "Green day so far"
                  ? "positive"
                  : "neutral"
              }
            />
            <StatPill
              label="Sentiment"
              value={<span className={netSentimentClass}>{netSentiment}</span>}
              tone={
                netPnl > 0.01
                  ? "positive"
                  : netPnl < -0.01
                  ? "negative"
                  : "neutral"
              }
            />
          </div>
        </header>

        <main className="max-w-6xl mx-auto px-4 pt-6 pb-24 space-y-6">
          {statsError && (
            <p className="text-xs text-[var(--ci-negative)]">{statsError}</p>
          )}

          <div className="space-y-6">
            <AiHealthPill />
            <IntradayFunnel />
          </div>

          {/* High-level performance tiles */}
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-neutral-100">
              Session performance
            </h2>
            <p className="text-[11px] text-neutral-500">
              Quick view of your paper trading stats for this session.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
              <StatTile
                label="Total trades"
                value={stats?.totalTrades ?? "—"}
              />
              <StatTile
                label="Win rate"
                value={
                  stats && stats.totalTrades
                    ? `${(
                        ((stats.wins ?? 0) / stats.totalTrades) *
                        100
                      ).toFixed(1)}%`
                    : "—"
                }
                detail={
                  stats
                    ? `${stats.wins ?? 0}W / ${
                        stats.losses ?? 0
                      }L / ${stats.breakeven ?? 0}BE`
                    : undefined
                }
              />
              <StatTile
                label="Realized P&L"
                value={
                  stats?.totalRealizedPnL != null
                    ? `$${stats.totalRealizedPnL.toFixed(2)}`
                    : "—"
                }
                detail={
                  stats?.avgRealizedR != null
                    ? `≈ ${netR.toFixed(2)}R`
                    : undefined
                }
              />
              <StatTile
                label="Avg R / trade"
                value={
                  stats?.avgRealizedR != null
                    ? `${stats.avgRealizedR.toFixed(2)}R`
                    : "—"
                }
              />
              <StatTile
                label="Best trade (R)"
                value={
                  stats?.bestR != null ? `${stats.bestR.toFixed(2)}R` : "—"
                }
              />
              <StatTile
                label="Worst trade (R)"
                value={
                  stats?.worstR != null ? `${stats.worstR.toFixed(2)}R` : "—"
                }
              />
              <StatTile
                label="Max drawdown"
                value={
                  stats?.maxDrawdown != null
                    ? `$${stats.maxDrawdown.toFixed(2)}`
                    : "—"
                }
              />
              <StatTile
                label="Auto-stops today"
                value={stats?.autoStopsAppliedToday ?? "—"}
              />
            </div>
          </section>
        </main>
      </div>
    </>
  );
}
