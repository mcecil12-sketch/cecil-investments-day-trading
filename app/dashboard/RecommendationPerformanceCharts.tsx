"use client";

import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis, Tooltip } from "recharts";
import { alphaColor, formatCurrency, formatDate, formatPercent } from "@/lib/format";
import { TIMEFRAME_DAYS, TIMEFRAMES, type TimeframeKey } from "@/lib/timeframes";

export interface PickQualityChartPoint {
  date: string;
  pickReturn: number | null;
  spxReturn: number | null;
  activeCount: number;
}

export interface SimulatedPortfolioChartPoint {
  date: string;
  portfolioValue: number;
  pnl: number;
  pnlPct: number;
  activeCount: number;
}

interface Props {
  pickQualityByTimeframe: Record<TimeframeKey, PickQualityChartPoint[]>;
  simulatedPortfolio?: SimulatedPortfolioChartPoint[];
  baseValue?: number;
  trackedSince: string | null;
  totalPositions: number;
  /** Sentence appended to "Tracking N positions since {date}." — describes this view's specific entry/exit rule, since Group 1, Group 3 Top 10, and Group 3 Top 30 each use a different one. */
  trackingNote: string;
  /** Suppresses View 2 (Simulated Position-Sized Portfolio) — used for pick-quality-only views like Group 3's Top 30, where dollar-sizing unbought candidates wouldn't map to anything real. Defaults to true. */
  showSimulatedPortfolio?: boolean;
  /** Card heading — defaults to "Recommendation Performance". */
  title?: string;
}

/** Dark-mode categorical pair validated for this app's --bg-elevated surface (see dataviz skill). */
const SERIES_PICKS = "#3987e5";
const SERIES_SPX = "#d95926";

/** Slices a date-ascending series to the trailing N days ending on its own last point — dates are "YYYY-MM-DD" strings, so lexicographic comparison is chronological. */
function filterByTimeframe<T extends { date: string }>(points: T[], days: number | null): T[] {
  if (days == null || points.length === 0) return points;
  const cutoff = new Date(`${points[points.length - 1].date}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return points.filter((p) => p.date >= cutoffStr);
}

/** True compounded return over the displayed window, using the portfolio's actual mark-to-market value at each end — not a subtraction of the cumulative pnlPct field, which would give a percentage-point difference rather than a genuine window return. */
function windowReturnFromValue(startValue: number | null | undefined, endValue: number | null | undefined): number | null {
  if (startValue == null || endValue == null || startValue === 0) return null;
  return (endValue - startValue) / startValue;
}

/** Dollar P&L over the window (last minus first) — unlike pnlPct, dollar amounts subtract linearly regardless of compounding, so no re-basing is needed. */
function windowDelta(first: number | null | undefined, last: number | null | undefined): number | null {
  if (first == null || last == null) return null;
  return last - first;
}

function tickDate(value: string): string {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

interface TooltipPayloadEntry {
  dataKey: string;
  name: string;
  value: number | null;
  color: string;
}

function ChartTooltip({
  active,
  payload,
  label,
  formatValue,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
  formatValue: (v: number | null) => string;
}) {
  if (!active || !payload || payload.length === 0 || !label) return null;
  return (
    <div
      style={{
        background: "var(--bg-elevated)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: "0.5rem 0.65rem",
        fontSize: "0.78rem",
      }}
    >
      <div style={{ color: "var(--text-muted)", marginBottom: "0.25rem" }}>{tickDate(label)}</div>
      {payload.map((entry) => (
        <div key={entry.dataKey} style={{ color: entry.color, fontFamily: "var(--font-mono)" }}>
          {entry.name}: {formatValue(entry.value)}
        </div>
      ))}
    </div>
  );
}

function LegendRow({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="rec-perf-legend">
      {items.map((item) => (
        <span className="rec-perf-legend-item" key={item.label}>
          <span className="rec-perf-legend-dot" style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

export function RecommendationPerformanceCharts({
  pickQualityByTimeframe,
  simulatedPortfolio = [],
  baseValue = 0,
  trackedSince,
  totalPositions,
  trackingNote,
  showSimulatedPortfolio = true,
  title = "Recommendation Performance",
}: Props) {
  const [timeframe, setTimeframe] = useState<TimeframeKey>("All");

  const windowPickQuality = pickQualityByTimeframe[timeframe] ?? [];
  const windowSimulatedPortfolio = useMemo(
    () => filterByTimeframe(simulatedPortfolio, TIMEFRAME_DAYS[timeframe]),
    [simulatedPortfolio, timeframe],
  );

  if (totalPositions === 0) {
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>{title}</h2>
        <p style={{ color: "var(--text-muted)" }}>
          No recommendations logged yet — this fills in once the Candidate Scanner&apos;s weekly batch runs.
        </p>
      </div>
    );
  }

  // Each timeframe's pickQuality series is already re-based to that window's own start server-side
  // (see recommendationPerformance.ts), so the last point's values ARE the window's return — no further diffing needed.
  const lastPick = windowPickQuality[windowPickQuality.length - 1] ?? null;
  const firstSim = windowSimulatedPortfolio[0] ?? null;
  const lastSim = windowSimulatedPortfolio[windowSimulatedPortfolio.length - 1] ?? null;

  const windowPickReturn = lastPick?.pickReturn ?? null;
  const windowSpxReturn = lastPick?.spxReturn ?? null;
  const windowPnl = windowDelta(firstSim?.pnl, lastSim?.pnl);
  const windowPnlPct = windowReturnFromValue(firstSim?.portfolioValue, lastSim?.portfolioValue);

  const trackedSinceLabel = trackedSince ? formatDate(new Date(trackedSince)) : "—";

  return (
    <div>
      <h2 style={{ marginBottom: "0.25rem" }}>{title}</h2>
      <p style={{ color: "var(--text-muted)", fontSize: "0.8rem", marginTop: 0, marginBottom: "1rem" }}>
        Tracking {totalPositions} position{totalPositions === 1 ? "" : "s"} since{" "}
        {trackedSinceLabel}. {trackingNote}
      </p>

      <div className="rec-perf-timeframe">
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf.key}
            type="button"
            className={`rec-perf-timeframe-btn${timeframe === tf.key ? " active" : ""}`}
            onClick={() => setTimeframe(tf.key)}
          >
            {tf.label}
          </button>
        ))}
      </div>

      <div className="card">
        <div className="agent-card-header">
          <strong>View 1 — Pure Pick Quality</strong>
          {lastPick && (
            <span style={{ color: "var(--text-muted)", fontSize: "0.78rem" }}>{lastPick.activeCount} tracked</span>
          )}
        </div>
        <p style={{ color: "var(--text-muted)", fontSize: "0.78rem", marginTop: 0 }}>
          Raw price return of each recommendation since its logged date, equal-weighted — no position sizing. Answers
          &quot;was the pick right,&quot; independent of execution.
        </p>
        <LegendRow
          items={[
            { label: "Recommended Picks", color: SERIES_PICKS },
            { label: "S&P 500", color: SERIES_SPX },
          ]}
        />
        <div style={{ width: "100%", height: 220 }}>
          <ResponsiveContainer>
            <LineChart data={windowPickQuality} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={tickDate}
                stroke="var(--text-muted)"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                minTickGap={32}
              />
              <YAxis
                tickFormatter={(v: number) => formatPercent(v)}
                stroke="var(--text-muted)"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                width={48}
              />
              <Tooltip content={<ChartTooltip formatValue={formatPercent} />} />
              <Line
                type="monotone"
                dataKey="pickReturn"
                name="Recommended Picks"
                stroke={SERIES_PICKS}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="spxReturn"
                name="S&P 500"
                stroke={SERIES_SPX}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
        {lastPick && (
          <div className="rec-perf-summary">
            <span>
              Picks:{" "}
              <strong className="mono" style={{ color: alphaColor(windowPickReturn) }}>
                {formatPercent(windowPickReturn)}
              </strong>
            </span>
            <span>
              S&amp;P 500: <strong className="mono">{formatPercent(windowSpxReturn)}</strong>
            </span>
          </div>
        )}
        <details style={{ marginTop: "0.6rem" }}>
          <summary style={{ cursor: "pointer", color: "var(--text-muted)", fontSize: "0.78rem" }}>
            View data table
          </summary>
          <div className="table-wrap" style={{ marginTop: "0.5rem" }}>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Picks</th>
                  <th>S&amp;P 500</th>
                  <th>Tracked</th>
                </tr>
              </thead>
              <tbody>
                {[...windowPickQuality].reverse().map((p) => (
                  <tr key={p.date}>
                    <td className="mono">{formatDate(new Date(p.date))}</td>
                    <td className="mono">{formatPercent(p.pickReturn)}</td>
                    <td className="mono">{formatPercent(p.spxReturn)}</td>
                    <td className="mono">{p.activeCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>

      {showSimulatedPortfolio && (
        <div className="card">
          <div className="agent-card-header">
            <strong>View 2 — Simulated Position-Sized Portfolio</strong>
            {lastSim && (
              <span style={{ color: "var(--text-muted)", fontSize: "0.78rem" }}>{lastSim.activeCount} positions</span>
            )}
          </div>
          <p style={{ color: "var(--text-muted)", fontSize: "0.78rem", marginTop: 0 }}>
            Each recommendation sized at the midpoint of its conviction band (e.g. a 4.0%–6.0% suggestion uses 5.0%)
            against a fixed hypothetical {formatCurrency(baseValue)} starting portfolio.
          </p>
          <div style={{ width: "100%", height: 220 }}>
            <ResponsiveContainer>
              <LineChart data={windowSimulatedPortfolio} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={tickDate}
                  stroke="var(--text-muted)"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={32}
                />
                <YAxis
                  tickFormatter={(v: number) => formatCurrency(v)}
                  stroke="var(--text-muted)"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  width={64}
                />
                <Tooltip content={<ChartTooltip formatValue={formatCurrency} />} />
                <ReferenceLine y={baseValue} stroke="var(--text-muted)" strokeDasharray="3 3" />
                <Line
                  type="monotone"
                  dataKey="portfolioValue"
                  name="Simulated Portfolio"
                  stroke={SERIES_PICKS}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          {lastSim && (
            <div className="rec-perf-summary">
              <span>
                Value: <strong className="mono">{formatCurrency(lastSim.portfolioValue)}</strong>
              </span>
              <span>
                P&amp;L:{" "}
                <strong className="mono" style={{ color: alphaColor(windowPnl) }}>
                  {formatCurrency(windowPnl)} ({formatPercent(windowPnlPct)})
                </strong>
              </span>
            </div>
          )}
          <details style={{ marginTop: "0.6rem" }}>
            <summary style={{ cursor: "pointer", color: "var(--text-muted)", fontSize: "0.78rem" }}>
              View data table
            </summary>
            <div className="table-wrap" style={{ marginTop: "0.5rem" }}>
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Portfolio Value</th>
                    <th>P&amp;L</th>
                    <th>Positions</th>
                  </tr>
                </thead>
                <tbody>
                  {[...windowSimulatedPortfolio].reverse().map((p) => (
                    <tr key={p.date}>
                      <td className="mono">{formatDate(new Date(p.date))}</td>
                      <td className="mono">{formatCurrency(p.portfolioValue)}</td>
                      <td className="mono">{formatCurrency(p.pnl)}</td>
                      <td className="mono">{p.activeCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <p className="rec-perf-disclaimer">
            Simulated performance based on recommended position sizing — not a real account and not investment advice.
          </p>
        </div>
      )}
    </div>
  );
}
