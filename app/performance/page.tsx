"use client";

import { useMemo } from "react";
import { useTrading } from "../tradingContext";

function formatCurrency(value: number) {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  return `${sign}$${abs.toFixed(2)}`;
}

function formatR(value: number) {
  if (!Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value).toFixed(2);
  return `${sign}${abs}R`;
}

function safeRealizedPnL(trade: any): number {
  return typeof trade.realizedPnL === "number" ? trade.realizedPnL : 0;
}

export default function PerformancePage() {
  const { trades, settings } = useTrading();
  const ONE_R_DOLLARS = settings.oneR || 100;

  const closedTrades = useMemo(
    () => trades.filter((t) => t.status === "CLOSED"),
    [trades]
  );

  if (closedTrades.length === 0) {
    return (
      <div className="screen-container">
        <h2 className="section-title">Performance snapshot</h2>
        <p
          style={{
            fontSize: "0.75rem",
            color: "#9ca3af",
            marginTop: "8px",
          }}
        >
          No closed trades yet. Close trades on the Trades tab to see
          performance here.
        </p>
      </div>
    );
  }

  let totalPnL = 0;
  let wins = 0;
  let losses = 0;
  let bestR = -Infinity;
  let worstR = Infinity;

  closedTrades.forEach((trade) => {
    const pnl = safeRealizedPnL(trade);
    totalPnL += pnl;

    const r = pnl / ONE_R_DOLLARS;

    if (r > 0) wins += 1;
    if (r < 0) losses += 1;

    if (r > bestR) bestR = r;
    if (r < worstR) worstR = r;
  });

  const tradeCount = closedTrades.length;
  const winRate = tradeCount > 0 ? (wins / tradeCount) * 100 : 0;
  const totalR = totalPnL / ONE_R_DOLLARS;
  const avgR = tradeCount > 0 ? totalR / tradeCount : 0;

  const winTrades = closedTrades.filter((t) => safeRealizedPnL(t) > 0);
  const lossTrades = closedTrades.filter((t) => safeRealizedPnL(t) < 0);

  const sumPnL = (arr: typeof closedTrades) =>
    arr.reduce((acc, t) => acc + safeRealizedPnL(t), 0);

  const avgWinDollar =
    winTrades.length > 0 ? sumPnL(winTrades) / winTrades.length : 0;
  const avgLossDollar =
    lossTrades.length > 0 ? sumPnL(lossTrades) / lossTrades.length : 0;

  const avgWinR = avgWinDollar / ONE_R_DOLLARS;
  const avgLossR = avgLossDollar / ONE_R_DOLLARS;

  const grossWin = sumPnL(winTrades);
  const grossLoss = Math.abs(sumPnL(lossTrades));
  const profitFactor =
    grossLoss === 0 ? 0 : grossWin / grossLoss;

  const lossRate =
    tradeCount > 0 ? lossTrades.length / tradeCount : 0;
  const expectancyDollar =
    (winRate / 100) * avgWinDollar - lossRate * Math.abs(avgLossDollar);
  const expectancyR = expectancyDollar / ONE_R_DOLLARS;

  const bestRDisplay = Number.isFinite(bestR) ? formatR(bestR) : "—";
  const worstRDisplay = Number.isFinite(worstR) ? formatR(worstR) : "—";

  return (
    <div className="screen-container">
      <h2 className="section-title">Performance snapshot</h2>

      <div className="stat-box">
        <div className="stat-header">
          <span className="stat-title">All closed trades</span>
          <span className="stat-chip">{tradeCount} trades</span>
        </div>

        <div className="grid">
          <div>
            <span className="grid-label">Net P&amp;L</span>
            <span
              className={`grid-value ${
                totalPnL >= 0 ? "value-positive" : "value-negative"
              }`}
            >
              {formatCurrency(totalPnL)}
            </span>
          </div>
          <div>
            <span className="grid-label">Net R</span>
            <span
              className={`grid-value ${
                totalR >= 0 ? "value-positive" : "value-negative"
              }`}
            >
              {formatR(totalR)}
            </span>
          </div>
          <div>
            <span className="grid-label">Win rate</span>
            <span className="grid-value">
              {winRate.toFixed(1)}%
            </span>
          </div>
          <div>
            <span className="grid-label">Avg R / trade</span>
            <span
              className={`grid-value ${
                avgR >= 0 ? "value-positive" : "value-negative"
              }`}
            >
              {formatR(avgR)}
            </span>
          </div>
          <div>
            <span className="grid-label">Avg win (R)</span>
            <span
              className={`grid-value ${
                avgWinR >= 0 ? "value-positive" : "value-negative"
              }`}
            >
              {winTrades.length === 0 ? "—" : formatR(avgWinR)}
            </span>
          </div>
          <div>
            <span className="grid-label">Avg loss (R)</span>
            <span
              className={`grid-value ${
                avgLossR >= 0 ? "value-positive" : "value-negative"
              }`}
            >
              {lossTrades.length === 0 ? "—" : formatR(avgLossR)}
            </span>
          </div>
          <div>
            <span className="grid-label">Profit factor</span>
            <span
              className={`grid-value ${
                profitFactor >= 1 ? "value-positive" : "value-negative"
              }`}
            >
              {profitFactor === 0 ? "—" : profitFactor.toFixed(2)}
            </span>
          </div>
          <div>
            <span className="grid-label">Expectancy / trade</span>
            <span className="grid-value">
              {formatR(expectancyR)}
            </span>
          </div>
          <div>
            <span className="grid-label">Best trade</span>
            <span className={`grid-value ${bestR >= 0 ? "value-positive" : "value-negative"}`}>
              {bestRDisplay}
            </span>
          </div>
          <div>
            <span className="grid-label">Toughest trade</span>
            <span className={`grid-value ${worstR <= 0 ? "value-negative" : "value-positive"}`}>
              {worstRDisplay}
            </span>
          </div>
        </div>
      </div>

      <div className="stat-notes">
        <p>Notes</p>
        <ul>
          <li>
            Wins: {wins} · Losses: {losses} · Total: {tradeCount}
          </li>
          <li>
            R is based on your current $/R setting in Settings.
          </li>
          <li>
            Close trades on the Trades tab with a realized P&amp;L to feed
            this dashboard.
          </li>
        </ul>
      </div>
    </div>
  );
}
