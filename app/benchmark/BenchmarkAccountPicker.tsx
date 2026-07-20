"use client";

import { useState } from "react";
import { alphaColor, formatPercent } from "@/lib/format";

export interface BenchmarkPeriodRow {
  period: string;
  label: string;
  portfolioReturn: number | null;
  sp500Return: number | null;
  alpha: number | null;
  detail: string;
}

export interface BenchmarkSincePurchaseRow {
  portfolioReturn: number | null;
  sp500Return: number | null;
  alpha: number | null;
  detail: string;
}

export interface BenchmarkScopeView {
  id: string;
  label: string;
  meta: string;
  periods: BenchmarkPeriodRow[];
  sincePurchase: BenchmarkSincePurchaseRow | null;
}

/**
 * "Total Portfolio" is always views[0] (the caller puts it first), so
 * defaulting local state to views[0]'s id makes it the picker's default
 * without any extra prop.
 */
export function BenchmarkAccountPicker({ views }: { views: BenchmarkScopeView[] }) {
  const [selectedId, setSelectedId] = useState(views[0]?.id ?? "");
  const view = views.find((v) => v.id === selectedId) ?? views[0];

  if (!view) return null;

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
        <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} aria-label="Account">
          {views.map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </select>
        {view.meta && <span style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>{view.meta}</span>}
      </div>

      {view.periods.length === 0 && !view.sincePurchase ? (
        <p style={{ color: "var(--text-muted)" }}>No position data yet — import a statement to see benchmark data.</p>
      ) : (
        <div className="table-wrap" style={{ marginTop: "0.75rem" }}>
          <table>
            <thead>
              <tr>
                <th>Period</th>
                <th>Portfolio Return</th>
                <th>S&amp;P 500 Return</th>
                <th>Alpha</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {view.periods.map((row) => (
                <tr key={row.period}>
                  <td>{row.label}</td>
                  <td className="mono">{formatPercent(row.portfolioReturn)}</td>
                  <td className="mono">{formatPercent(row.sp500Return)}</td>
                  <td className="mono" style={{ color: alphaColor(row.alpha) }}>
                    {formatPercent(row.alpha)}
                  </td>
                  <td className="mono" style={{ color: "var(--text-muted)" }}>
                    {row.detail}
                  </td>
                </tr>
              ))}
              {view.sincePurchase && (
                <tr>
                  <td>Since Purchase (cost basis)</td>
                  <td className="mono">{formatPercent(view.sincePurchase.portfolioReturn)}</td>
                  <td className="mono">{formatPercent(view.sincePurchase.sp500Return)}</td>
                  <td className="mono" style={{ color: alphaColor(view.sincePurchase.alpha) }}>
                    {formatPercent(view.sincePurchase.alpha)}
                  </td>
                  <td className="mono" style={{ color: "var(--text-muted)" }}>
                    {view.sincePurchase.detail}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
