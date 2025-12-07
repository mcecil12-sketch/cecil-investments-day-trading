"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useTrading, TradeSide, Trade } from "../tradingContext";
import { computeRiskPerShare } from "../../lib/risk";

type IncomingSignal = {
  id: string;
  ticker: string;
  side: TradeSide;
  entryPrice: number;
  stopPrice?: number | null;
  targetPrice?: number | null;
  reasoning?: string;
  source?: string;
  createdAt?: string;
  priority?: number;
  trendScore?: number;
  liquidityScore?: number;
  playbookScore?: number;
  volumeScore?: number;
  catalystScore?: number;
};

type SignalsResponse = {
  signals: IncomingSignal[];
};

type AutoSide = "long" | "short";
type AutoTrade = {
  id: string;
  symbol: string;
  side: AutoSide;
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
  partialPlan?: { rMultiple: number; percent: number; label?: string; filled?: boolean }[];
  hitTargets?: number[];
  currentR?: number;
  lastPrice?: number;
  realizedPnL?: number;
  realizedR?: number;
  recommendedActions?: string[];
  engineLog?: string[];
};

type AutoSummary = {
  totalTrades: number;
  openTrades: number;
  updatedTrades: number;
  symbolCount: number;
  maxR?: number;
  minR?: number;
};

type AutoManageResponse = {
  ok: boolean;
  summary?: AutoSummary;
  trades?: AutoTrade[];
  error?: string;
};

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
  autoManagementEnabled?: boolean;
  maxRiskPerTrade?: number;
  maxRiskPerDay?: number;
  maxTradesPerDay?: number;
  autoEntryReady?: boolean;
  autoEntryNotes?: string;
};

function computeSizing(oneR: number, entryPrice: number, stopPrice?: number | null) {
  const riskPerShare = computeRiskPerShare(entryPrice, stopPrice);
  if (!oneR || !riskPerShare) return { size: 0, dollarRisk: 0, riskPerShare };
  const size = Math.floor(oneR / riskPerShare);
  const dollarRisk = size * riskPerShare;
  return { size, dollarRisk, riskPerShare };
}

function StatTile({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  tone?: "positive" | "negative";
}) {
  return (
    <div className="bg-[var(--ci-card)] border border-[var(--ci-border)] rounded-xl p-4 md:p-6 shadow-[0_0_12px_rgba(255,255,255,0.03)] space-y-1">
      <div className="text-[var(--ci-text-muted)] text-xs uppercase tracking-wide">
        {label}
      </div>
      <div
        className={`text-[var(--ci-accent)] text-2xl md:text-3xl font-light ${
          tone === "positive"
            ? "text-[var(--ci-positive)]"
            : tone === "negative"
            ? "text-[var(--ci-negative)]"
            : ""
        }`}
      >
        {value}
      </div>
      {detail && <div className="text-[var(--ci-text-muted)] text-xs">{detail}</div>}
    </div>
  );
}

export default function TodayPage() {
  const { settings, dailyPnL, addTrade } = useTrading();
  const [signals, setSignals] = useState<IncomingSignal[]>([]);
  const [loadingSignals, setLoadingSignals] = useState(false);
  const [riskDollars, setRiskDollars] = useState(150);
  const [statusBySignal, setStatusBySignal] = useState<Record<string, string>>({});
  const [manageSyncError, setManageSyncError] = useState<string | null>(null);
  const [dailyStats, setDailyStats] = useState<Stats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [settingsData, setSettingsData] = useState<SettingsData | null>(null);
  const [autoTrades, setAutoTrades] = useState<AutoTrade[]>([]);
  const [autoSummary, setAutoSummary] = useState<AutoSummary | null>(null);
  const [loadingAuto, setLoadingAuto] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);
  const [spyStatusText, setSpyStatusText] = useState<string>("");

  const oneR = settings.oneR;
  const dailyMaxLossR = settings.dailyMaxLossR;
  const dailyMaxLossDollar = dailyMaxLossR * oneR;
  const chosenRisk = riskDollars || oneR;

  const lossUsedDollar = dailyPnL < 0 ? Math.abs(dailyPnL) : 0;
  const lossUsedR = oneR > 0 && lossUsedDollar > 0 ? lossUsedDollar / oneR : 0;
  const remainingR = Math.max(dailyMaxLossR - lossUsedR, 0);
  const blockedForDay = lossUsedR >= dailyMaxLossR;

  let statusText = "Flat";
  if (blockedForDay) statusText = "Max loss reached · new approvals blocked";
  else if (dailyPnL > 0) statusText = "Green day so far";
  else if (dailyPnL < 0 && lossUsedR < dailyMaxLossR * 0.5) statusText = "Drawdown · stay selective";
  else if (dailyPnL < 0 && lossUsedR >= dailyMaxLossR * 0.5) statusText = "Near daily loss limit";

  useEffect(() => {
    async function fetchSignals() {
      setLoadingSignals(true);
      try {
        const res = await fetch("/api/signals");
        if (!res.ok) throw new Error("Failed to fetch signals");
        const data = (await res.json()) as SignalsResponse;
        setSignals(data.signals || []);
      } catch (err) {
        console.error(err);
      } finally {
        setLoadingSignals(false);
      }
    }
    fetchSignals();
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const res = await fetch("/api/trades/summary");
      if (!res.ok) throw new Error(`Stats failed (${res.status})`);
      const data = await res.json();
      setDailyStats(data?.stats ?? null);
      setStatsError(null);
    } catch (err: any) {
      console.error("[today] stats load failed", err);
      setStatsError(err?.message || "Stats unavailable");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (cancelled) return;
      await loadStats();
    };
    run();
    const interval = setInterval(run, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [loadStats]);

  // Auto-sync manage + refresh stats
  useEffect(() => {
    let cancelled = false;
    const sync = async () => {
      try {
        const res = await fetch("/api/trades/manage");
        if (!res.ok) throw new Error(`manage failed (${res.status})`);
        setManageSyncError(null);
        await loadStats();
      } catch (err: any) {
        console.error("[today] manage sync failed", err);
        if (!cancelled) setManageSyncError("Sync failed");
      }
    };
    sync();
    const interval = setInterval(sync, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [loadStats]);

  // Settings
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/settings");
        if (!res.ok) throw new Error("Failed to load settings");
        const data = await res.json();
        if (!cancelled) setSettingsData(data?.settings ?? null);
      } catch (err) {
        console.error("[today] load settings failed", err);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-managed trades view
  const loadAutoTrades = useCallback(async () => {
    try {
      setLoadingAuto(true);
      setAutoError(null);
      const res = await fetch("/api/auto-manage");
      if (!res.ok) throw new Error(`Failed to fetch auto-managed trades: ${res.statusText}`);
      const data: AutoManageResponse = await res.json();
      if (!data.ok) throw new Error(data.error || "Auto-manage API returned not ok");
      setAutoTrades(data.trades || []);
      setAutoSummary(data.summary || null);
    } catch (err: any) {
      console.error("[today] loadAutoTrades error", err);
      setAutoError(err?.message || "Failed to load engine data");
    } finally {
      setLoadingAuto(false);
    }
  }, []);

  useEffect(() => {
    loadAutoTrades();
  }, [loadAutoTrades]);

  const handleApprove = async (signal: IncomingSignal) => {
    if (blockedForDay) {
      if (typeof window !== "undefined") {
        window.alert("Daily loss limit reached · approvals are blocked for the rest of the day.");
      }
      return;
    }

    const { size, dollarRisk } = computeSizing(
      chosenRisk,
      signal.entryPrice,
      signal.stopPrice ?? undefined
    );

    if (!size) {
      if (typeof window !== "undefined") {
        window.alert("Cannot compute a valid position size for this setup.");
      }
      return;
    }

    setStatusBySignal((prev) => ({ ...prev, [signal.id]: "Submitting order…" }));

    const nowIso = new Date().toISOString();
    const tradeId = `signal-${signal.id}-${Date.now()}`;

    const newTrade: Trade = {
      id: tradeId,
      ticker: signal.ticker,
      side: signal.side,
      size,
      entryPrice: signal.entryPrice,
      stopPrice: signal.stopPrice ?? undefined,
      targetPrice: signal.targetPrice ?? undefined,
      openedAt: nowIso,
      status: "OPEN",
      notes: signal.reasoning,
      oneR: chosenRisk,
      initialDollarRisk: dollarRisk,
    };

    addTrade(newTrade);
    setSignals((prev) => prev.filter((s) => s.id !== signal.id));

    try {
      const res = await fetch("/api/trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...newTrade,
          signalId: signal.id,
          riskDollars: chosenRisk,
          submitToBroker: true,
          quantity: size,
          orderType: "market",
          timeInForce: "day",
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        setStatusBySignal((prev) => ({ ...prev, [signal.id]: `Error: ${res.status} ${text}` }));
        return;
      }

      const json = await res.json().catch(() => ({}));
      const alpacaOrderId = json?.trade?.alpacaOrderId;

      setStatusBySignal((prev) => ({
        ...prev,
        [signal.id]: `Order sent · tradeId ${tradeId}${alpacaOrderId ? ` · alpaca ${alpacaOrderId}` : ""}`,
      }));
    } catch (err: any) {
      setStatusBySignal((prev) => ({
        ...prev,
        [signal.id]: `Error: ${err?.message || "Failed to submit"}`,
      }));
      return;
    }

    if (typeof window !== "undefined") {
      window.alert(
        `Approved ${signal.ticker} · size ${size} · ~$${dollarRisk.toFixed(0)} risk (≈ 1R).`
      );
    }
  };

  // Lightweight helper to approve a signal and send to /api/trades with broker submission.
  async function approveSignal(signal: IncomingSignal) {
    try {
      const res = await fetch("/api/trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker: signal.ticker,
          side: (signal.side as any) ?? "LONG",
          quantity: (signal as any).positionSize ?? (signal as any).qty ?? 100,
          entryPrice: signal.entryPrice,
          stopPrice: signal.stopPrice,
          targetPrice: signal.targetPrice,
          reasoning: signal.reasoning,
          source: "VWAP Pullback Scanner",
          submitToBroker: true,
          orderType: "market",
          timeInForce: "day",
        }),
      });

      const json = await res.json();
      console.log("Trade created:", json);

      setSpyStatusText("Approved · Paper order sent");
    } catch (err) {
      console.error("Approve error:", err);
      setSpyStatusText("Error sending order");
    }
  }

  const handleDismiss = (id: string) => {
    setSignals((prev) => prev.filter((s) => s.id !== id));
    setStatusBySignal((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const sortedSignals = [...signals].sort((a, b) => {
    const pa = typeof a.priority === "number" ? a.priority : 0;
    const pb = typeof b.priority === "number" ? b.priority : 0;
    if (pb !== pa) return pb - pa;
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    return tb - ta;
  });

  const visibleSignals = sortedSignals.filter(
    (s) => (typeof s.priority === "number" ? s.priority : 0) >= 9
  );

  const sandboxSignals: IncomingSignal[] = [
    {
      id: "SPY-demo-long",
      ticker: "SPY",
      side: "LONG",
      entryPrice: 500,
      stopPrice: 495,
      targetPrice: 510,
      reasoning: "Demo: SPY pullback to support with clear risk.",
      source: "Sandbox",
    },
    {
      id: "QQQ-demo-short",
      ticker: "QQQ",
      side: "SHORT",
      entryPrice: 430,
      stopPrice: 435,
      targetPrice: 420,
      reasoning: "Demo: QQQ reversal from resistance.",
      source: "Sandbox",
    },
  ];

  const openAutoTrades = autoTrades.filter((t) => t.status === "open");

  return (
    <div className="min-h-screen bg-[var(--ci-bg)] text-[var(--ci-text)]">
      <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
        {/* Stats tiles */}
        <section className="space-y-3">
          {manageSyncError && (
            <p className="text-[var(--ci-negative)] text-sm">{manageSyncError}</p>
          )}
          {statsError ? (
            <div className="bg-[var(--ci-card)] border border-[var(--ci-border)] rounded-xl p-4 shadow-[0_0_12px_rgba(255,255,255,0.03)] text-[var(--ci-negative)] text-sm">
              Stats unavailable: {statsError}
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-[var(--ci-card)] border border-[var(--ci-border)] rounded-xl p-4 shadow-[0_0_12px_rgba(255,255,255,0.03)] space-y-1">
                <div className="text-[var(--ci-text-muted)] text-xs uppercase tracking-wide">
                  Today P&amp;L
                </div>
                <div
                  className={`text-[var(--ci-accent)] text-2xl md:text-3xl font-light ${
                    dailyPnL > 0
                      ? "text-[var(--ci-positive)]"
                      : dailyPnL < 0
                      ? "text-[var(--ci-negative)]"
                      : ""
                  }`}
                >
                  ${dailyPnL.toFixed(2)}
                </div>
              </div>
              <StatTile
                label="Net R"
                value={
                  oneR > 0 ? (dailyPnL / oneR).toFixed(2) + "R" : "—"
                }
              />
              <StatTile label="Trades" value={dailyStats?.totalTrades ?? "—"} />
              <StatTile
                label="Avg / Best / Worst R"
                value={
                  dailyStats
                    ? `${dailyStats.avgRealizedR != null ? dailyStats.avgRealizedR.toFixed(2) : "—"} / ${
                        dailyStats.bestR != null ? dailyStats.bestR.toFixed(2) : "—"
                      } / ${
                        dailyStats.worstR != null ? dailyStats.worstR.toFixed(2) : "—"
                      }`
                    : "—"
                }
              />
            </div>
          )}
        </section>

        {/* Risk dashboard */}
        <section className="bg-[var(--ci-card)] border border-[var(--ci-border)] rounded-xl p-4 md:p-6 shadow-[0_0_12px_rgba(255,255,255,0.03)] space-y-3">
          <div className="text-[var(--ci-text-muted)] text-xs uppercase tracking-wide">
            Risk &amp; Guardrails
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            <StatTile label="Account size" value={`$${settings.accountSize.toLocaleString()}`} />
            <StatTile
              label="Risk per trade"
              value={`${settings.riskPerTradePct.toFixed(2)}% · $${oneR.toFixed(0)}`}
            />
            <StatTile label="1R" value={`$${oneR.toFixed(0)}`} />
            <StatTile
              label="Daily max loss"
              value={`${dailyMaxLossR.toFixed(1)}R · $${dailyMaxLossDollar.toFixed(0)}`}
            />
            <StatTile
              label="Today P&L"
              value={`$${dailyPnL.toFixed(2)}`}
              tone={dailyPnL > 0 ? "positive" : dailyPnL < 0 ? "negative" : undefined}
            />
            <StatTile label="Loss used (R)" value={`${lossUsedR.toFixed(2)}R`} />
            <StatTile
              label="Remaining to limit"
              value={`${remainingR.toFixed(2)}R · $${Math.max(
                dailyMaxLossDollar - lossUsedDollar,
                0
              ).toFixed(0)}`}
            />
            <StatTile label="Status" value={statusText} />
            <StatTile
              label="Guardrails"
              value={
                settingsData
                  ? `Max/trade $${settingsData.maxRiskPerTrade ?? "—"} · Daily $${settingsData.maxRiskPerDay ?? "—"} · Trades/day ${settingsData.maxTradesPerDay ?? "—"}`
                  : "—"
              }
            />
            <StatTile
              label="Auto-management"
              value={settingsData?.autoManagementEnabled ? "ON" : "OFF"}
            />
            <StatTile
              label="Auto-entry"
              value={
                settingsData?.autoEntryReady
                  ? "READY (manual entries only)"
                  : "NOT READY"
              }
              detail={settingsData?.autoEntryNotes}
            />
            <div className="flex flex-col">
              <span className="text-[var(--ci-text-muted)] text-xs uppercase tracking-wide">
                Manual risk ($ per trade)
              </span>
              <input
                type="number"
                className="input"
                value={riskDollars}
                onChange={(e) => setRiskDollars(Number(e.target.value) || 0)}
                min={0}
                step={25}
                style={{
                  background: "var(--ci-card)",
                  border: "1px solid var(--ci-border)",
                  color: "var(--ci-text)",
                  padding: "8px",
                  borderRadius: "8px",
                  marginTop: "6px",
                }}
              />
            </div>
          </div>
        </section>

        {/* Pending approvals */}
        <section className="space-y-3">
          <h2 className="text-sm uppercase tracking-wide text-[var(--ci-text-muted)]">
            Pending approvals (A+ only ≥ 9)
          </h2>
          {spyStatusText && (
            <p className="text-xs text-[var(--ci-text-muted)]">{spyStatusText}</p>
          )}
          {loadingSignals && <p className="muted-text">Loading signals…</p>}
          {!loadingSignals && visibleSignals.length === 0 && (
            <p className="empty-text">
              No A+ setups right now. Stay patient and protect capital.
            </p>
          )}
          {visibleSignals.map((signal) => {
            const { size, dollarRisk, riskPerShare } = computeSizing(
              chosenRisk,
              signal.entryPrice,
              signal.stopPrice ?? undefined
            );
            return (
              <div
                key={signal.id}
                className="bg-[var(--ci-card)] border border-[var(--ci-border)] rounded-xl p-4 md:p-6 shadow-[0_0_12px_rgba(255,255,255,0.03)] space-y-3"
              >
                <div className="flex items-center justify-between">
                  <div className="pill-row">
                    <span className="pill ticker-pill">{signal.ticker}</span>
                    <span className={`pill side-pill ${signal.side.toLowerCase()}`}>
                      {signal.side}
                    </span>
                    {signal.source && <span className="pill source-pill">{signal.source}</span>}
                    {typeof signal.priority === "number" && (
                      <span className="pill priority-pill">P{signal.priority.toFixed(1)}</span>
                    )}
                  </div>
                  {signal.createdAt && (
                    <div className="muted-text small">
                      {new Date(signal.createdAt).toLocaleTimeString()}
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <div className="label">Entry</div>
                    <div className="value">{signal.entryPrice.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="label">Stop</div>
                    <div className="value">
                      {signal.stopPrice != null ? signal.stopPrice.toFixed(2) : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="label">Target</div>
                    <div className="value">
                      {signal.targetPrice != null ? signal.targetPrice.toFixed(2) : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="label">Sizing (≈)</div>
                    <div className="value">
                      {size ? `${size.toLocaleString()} sh · ~$${dollarRisk.toFixed(0)}` : "—"}
                      {riskPerShare ? ` · ${riskPerShare.toFixed(2)} /sh` : ""}
                    </div>
                  </div>
                </div>
                {signal.reasoning && (
                  <div>
                    <div className="label">Reasoning</div>
                    <div className="muted-text">{signal.reasoning}</div>
                  </div>
                )}
                <div className="flex items-center gap-2 mt-2">
                  <button
                    className="btn-approve"
                    disabled={blockedForDay}
                    onClick={() => handleApprove(signal)}
                  >
                    Approve
                  </button>
                  <button
                    className="btn-dismiss"
                    onClick={() => handleDismiss(signal.id)}
                  >
                    Dismiss
                  </button>
                </div>
                {statusBySignal[signal.id] && (
                  <div className="muted-text small">{statusBySignal[signal.id]}</div>
                )}
              </div>
            );
          })}
        </section>

        {/* Sandbox signals */}
        <section className="space-y-3">
          <h2 className="text-sm uppercase tracking-wide text-[var(--ci-text-muted)]">
            Sandbox · SPY / QQQ
          </h2>
          {sandboxSignals.map((signal) => {
            const { size, dollarRisk } = computeSizing(
              chosenRisk,
              signal.entryPrice,
              signal.stopPrice ?? undefined
            );
            return (
              <div
                key={signal.id}
                className="bg-[var(--ci-card)] border border-[var(--ci-border)] rounded-xl p-4 md:p-6 shadow-[0_0_12px_rgba(255,255,255,0.03)] space-y-3"
              >
                <div className="flex items-center justify-between">
                  <div className="pill-row">
                    <span className="pill ticker-pill">{signal.ticker}</span>
                    <span className={`pill side-pill ${signal.side.toLowerCase()}`}>
                      {signal.side}
                    </span>
                    <span className="pill source-pill">Demo</span>
                  </div>
                  <div className="muted-text small">{signal.reasoning ?? "Practice setup"}</div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <div className="label">Entry</div>
                    <div className="value">{signal.entryPrice.toFixed(2)}</div>
                  </div>
                  <div>
                    <div className="label">Stop</div>
                    <div className="value">
                      {signal.stopPrice != null ? signal.stopPrice.toFixed(2) : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="label">Target</div>
                    <div className="value">
                      {signal.targetPrice != null ? signal.targetPrice.toFixed(2) : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="label">Size (≈)</div>
                    <div className="value">
                      {size ? `${size.toLocaleString()} sh · ~$${dollarRisk.toFixed(0)}` : "—"}
                    </div>
                  </div>
                </div>
                <button
                  className="btn-approve"
                  disabled={blockedForDay}
                  onClick={() => handleApprove(signal)}
                >
                  Approve demo trade
                </button>
              </div>
            );
          })}
        </section>

        {/* Auto-managed open trades view */}
        <section className="bg-[var(--ci-card)] border border-[var(--ci-border)] rounded-xl p-4 md:p-6 shadow-[0_0_12px_rgba(255,255,255,0.03)] space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm uppercase tracking-wide text-[var(--ci-text-muted)]">
              Auto-managed open trades (engine view)
            </h2>
            <button
              className="inline-flex items-center justify-center px-3 py-1 rounded-lg text-xs font-medium border border-[var(--ci-accent)] text-[var(--ci-accent)] bg-transparent hover:bg-[var(--ci-card)] transition-colors"
              onClick={loadAutoTrades}
              disabled={loadingAuto}
            >
              {loadingAuto ? "Running engine…" : "Refresh engine"}
            </button>
          </div>
          {autoError && (
            <p className="text-[var(--ci-negative)] text-sm">{autoError}</p>
          )}
          {!loadingAuto && openAutoTrades.length === 0 && (
            <p className="muted-text">No open trades in the backend book right now.</p>
          )}
          {autoSummary && (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
              <StatTile label="Open trades" value={autoSummary.openTrades} />
              <StatTile label="Symbols tracked" value={autoSummary.symbolCount} />
              <StatTile label="Max R (book)" value={autoSummary.maxR != null ? autoSummary.maxR.toFixed(2) : "—"} />
              <StatTile label="Min R (book)" value={autoSummary.minR != null ? autoSummary.minR.toFixed(2) : "—"} />
            </div>
          )}
          {openAutoTrades.map((t) => (
            <div key={t.id} className="border-t border-[var(--ci-border)] pt-3">
              <div className="flex items-center justify-between">
                <div className="pill-row">
                  <span className="pill ticker-pill">{t.symbol}</span>
                  <span className={`pill side-pill ${t.side === "long" ? "long" : "short"}`}>
                    {t.side.toUpperCase()}
                  </span>
                  <span className="pill source-pill">
                    {t.currentSize}/{t.size} sh
                  </span>
                </div>
                <div className="muted-text small">Opened: {new Date(t.createdAt).toLocaleString()}</div>
              </div>
              <div className="grid grid-2 md:grid-cols-4 gap-3 mt-2">
                <div>
                  <div className="label">Entry</div>
                  <div className="value">{t.entryPrice.toFixed(2)}</div>
                </div>
                <div>
                  <div className="label">Stop</div>
                  <div className="value">{t.stopPrice.toFixed(2)}</div>
                </div>
                <div>
                  <div className="label">Last</div>
                  <div className="value">{t.lastPrice != null ? t.lastPrice.toFixed(2) : "—"}</div>
                </div>
                <div>
                  <div className="label">Current R</div>
                  <div className="value">{t.currentR != null ? t.currentR.toFixed(2) : "—"}</div>
                </div>
              </div>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}
