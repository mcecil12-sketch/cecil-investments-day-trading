"use client";

import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis, Tooltip } from "recharts";
import { alphaColor, formatCurrency, formatDate, formatPercent } from "@/lib/format";

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
  pickQuality: PickQualityChartPoint[];
  simulatedPortfolio: SimulatedPortfolioChartPoint[];
  baseValue: number;
  trackedSince: string | null;
  totalRecommendations: number;
}

/** Dark-mode categorical pair validated for this app's --bg-elevated surface (see dataviz skill). */
const SERIES_PICKS = "#3987e5";
const SERIES_SPX = "#d95926";

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
  pickQuality,
  simulatedPortfolio,
  baseValue,
  trackedSince,
  totalRecommendations,
}: Props) {
  if (totalRecommendations === 0) {
    return (
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Recommendation Performance</h2>
        <p style={{ color: "var(--text-muted)" }}>
          No recommendations logged yet — this fills in once the Candidate Scanner&apos;s weekly batch runs.
        </p>
      </div>
    );
  }

  const latestPick = pickQuality[pickQuality.length - 1] ?? null;
  const latestSim = simulatedPortfolio[simulatedPortfolio.length - 1] ?? null;
  const trackedSinceLabel = trackedSince ? formatDate(new Date(trackedSince)) : "—";

  return (
    <div>
      <h2 style={{ marginBottom: "0.25rem" }}>Recommendation Performance</h2>
      <p style={{ color: "var(--text-muted)", fontSize: "0.8rem", marginTop: 0, marginBottom: "1rem" }}>
        Tracking {totalRecommendations} logged recommendation{totalRecommendations === 1 ? "" : "s"} since{" "}
        {trackedSinceLabel}. Each point starts from that stock&apos;s own logged date forward — no backfilling.
      </p>

      <div className="card">
        <div className="agent-card-header">
          <strong>View 1 — Pure Pick Quality</strong>
          {latestPick && (
            <span style={{ color: "var(--text-muted)", fontSize: "0.78rem" }}>{latestPick.activeCount} tracked</span>
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
            <LineChart data={pickQuality} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
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
        {latestPick && (
          <div className="rec-perf-summary">
            <span>
              Picks:{" "}
              <strong className="mono" style={{ color: alphaColor(latestPick.pickReturn) }}>
                {formatPercent(latestPick.pickReturn)}
              </strong>
            </span>
            <span>
              S&amp;P 500: <strong className="mono">{formatPercent(latestPick.spxReturn)}</strong>
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
                {[...pickQuality].reverse().map((p) => (
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

      <div className="card">
        <div className="agent-card-header">
          <strong>View 2 — Simulated Position-Sized Portfolio</strong>
          {latestSim && (
            <span style={{ color: "var(--text-muted)", fontSize: "0.78rem" }}>{latestSim.activeCount} positions</span>
          )}
        </div>
        <p style={{ color: "var(--text-muted)", fontSize: "0.78rem", marginTop: 0 }}>
          Each recommendation sized at the midpoint of its conviction band (e.g. a 4.0%–6.0% suggestion uses 5.0%)
          against a fixed hypothetical {formatCurrency(baseValue)} starting portfolio.
        </p>
        <div style={{ width: "100%", height: 220 }}>
          <ResponsiveContainer>
            <LineChart data={simulatedPortfolio} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
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
        {latestSim && (
          <div className="rec-perf-summary">
            <span>
              Value: <strong className="mono">{formatCurrency(latestSim.portfolioValue)}</strong>
            </span>
            <span>
              P&amp;L:{" "}
              <strong className="mono" style={{ color: alphaColor(latestSim.pnl) }}>
                {formatCurrency(latestSim.pnl)} ({formatPercent(latestSim.pnlPct)})
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
                {[...simulatedPortfolio].reverse().map((p) => (
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
    </div>
  );
}
