"use client";

import { useTrading } from "./tradingContext";

function formatDollar(value: number): string {
  const sign = value >= 0 ? "+" : "−";
  const abs = Math.abs(value).toFixed(0);
  return `${sign} $${abs}`;
}

function formatR(value: number): string {
  const sign = value >= 0 ? "+" : "−";
  const abs = Math.abs(value).toFixed(1);
  return `${sign} ${abs}R`;
}

export default function HeaderStats() {
  const { trades, dailyPnL, settings } = useTrading();
  const oneR = settings.oneR || 100;

  const totalRealized = trades.reduce(
    (sum, t) => sum + (t.realizedPnL ?? 0),
    0
  );

  const netR = oneR ? totalRealized / oneR : 0;

  return (
    <>
      <div className="pill">
        <span className="pill-label">Today P&amp;L</span>
        <span className="pill-value">{formatDollar(dailyPnL)}</span>
      </div>

      <div className="pill">
        <span className="pill-label">Net R</span>
        <span className="pill-value">{formatR(netR)}</span>
      </div>

      <div className="pill">
        <span className="pill-label">Trades</span>
        <span className="pill-value">{trades.length}</span>
      </div>
    </>
  );
}
