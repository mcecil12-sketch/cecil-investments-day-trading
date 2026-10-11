"use client";

import { useState } from "react";
import type { MonthlyScanDryRunReport } from "@/lib/agents/monthlyScanDryRun";

const fmt = (v: number | null, digits = 2) => (v == null ? "—" : v.toFixed(digits));

/** Runs the monthly scan in dry-run mode (nothing persisted) and shows the diagnostic report. Takes up to ~4 minutes — it uses the real insider pacing. */
export function DryRunButton({ endpoint }: { endpoint: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<MonthlyScanDryRunReport | null>(null);

  async function handleClick() {
    setLoading(true);
    setError(null);
    setReport(null);
    try {
      const res = await fetch(`${endpoint}?dryRun=1`, { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
      setReport(body as MonthlyScanDryRunReport);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ marginTop: "0.5rem" }}>
      <button className="btn" onClick={handleClick} disabled={loading}>
        {loading ? "Dry run… (up to ~4 min)" : "Dry run"}
      </button>
      {error && <p style={{ color: "var(--negative)", fontSize: "0.8rem", marginTop: "0.4rem" }}>{error}</p>}
      {report && (
        <div style={{ marginTop: "0.6rem", fontSize: "0.82rem" }}>
          <p>
            <strong>Dry run — nothing written.</strong> {(report.totalMs / 1000).toFixed(1)}s of {report.maxDurationMs / 1000}s ({report.percentOfMaxDuration}%).
          </p>
          <p style={{ color: "var(--text-muted)" }}>
            Phases (ms): {Object.entries(report.phaseMs).map(([k, v]) => `${k} ${v}`).join(" · ")}
          </p>
          <p>
            Symbols: {report.counts.universeSymbols} universe · {report.counts.ranked} ranked · {report.counts.skipped} skipped · would write {report.counts.wouldWriteRows} rows · {report.fragilityFlagCount} fragile
          </p>
          <p>
            Insider: {report.insider.insiderCallsUsed} calls · {report.insider.insiderSucceeded} ok · {report.insider.insiderNoFilings} no filings · {report.insider.insiderEmpty} empty (AV) · {report.insider.insiderFailed} failed · {report.insider.insiderSkippedByDeadline} skipped by deadline{report.insider.deadlineHit ? " (deadline hit)" : ""} · {report.insider.insiderRequests} HTTP requests in {(report.insider.elapsedMs / 1000).toFixed(1)}s · EDGAR {report.insider.insiderFromEdgar} / Alpha Vantage {report.insider.insiderFromAlphaVantage} · {report.insider.fitsTimeBudget ? "fits the time budget" : "does NOT fit — needs resumed passes"}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Rank</th><th>Symbol</th><th>Composite</th><th>Ext vs 200d</th><th>Vol 60d</th><th>Frag. pctile</th><th>Fragile</th><th>Insider net sold</th><th>Market cap</th><th>% of cap</th></tr>
              </thead>
              <tbody>
                {report.top10.map((r) => (
                  <tr key={r.symbol}>
                    <td>{r.rank}</td>
                    <td>{r.symbol}</td>
                    <td className="mono">{r.composite}</td>
                    <td className="mono">{fmt(r.extensionVs200d)}</td>
                    <td className="mono">{fmt(r.vol60d)}</td>
                    <td className="mono">{r.fragilityPercentile == null ? "n/a" : r.fragilityPercentile.toFixed(0)}</td>
                    <td>{r.fragilityFlag == null ? "—" : r.fragilityFlag ? "yes" : "no"}</td>
                    <td className="mono">{r.insiderStatus === "no_filings" ? "$0 (no filings)" : r.insiderNetSoldUsd30d == null ? "n/a" : `$${Math.round(r.insiderNetSoldUsd30d).toLocaleString("en-US")}`}</td>
                    <td className="mono">{r.marketCap == null ? "n/a" : `$${(r.marketCap / 1e9).toFixed(1)}B`}</td>
                    <td className="mono">{r.insiderNetSoldPctOfMarketCap == null ? "n/a" : `${r.insiderNetSoldPctOfMarketCap.toFixed(3)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ marginTop: "0.6rem", fontWeight: 600 }}>Insider diagnostics per ticker</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Symbol</th><th>Source</th><th>Status</th><th>Filings / requests</th><th>Rows returned</th><th>In 30d window</th><th>Sale rows counted</th><th>Net sold</th><th>Response keys / failure</th></tr>
              </thead>
              <tbody>
                {report.insiderByTicker.map((t) => (
                  <tr key={t.symbol}>
                    <td>{t.symbol}</td>
                    <td>{t.source ?? "—"}</td>
                    <td>{t.status}</td>
                    <td className="mono">{t.filings ?? "—"} / {t.requests}</td>
                    <td className="mono">{t.rowsReturned}</td>
                    <td className="mono">{t.rowsInWindow}</td>
                    <td className="mono">{t.saleRowsCounted}</td>
                    <td className="mono">{t.status === "no_filings" ? "$0 (no filings)" : t.netSoldUsd == null ? "n/a" : `$${Math.round(t.netSoldUsd).toLocaleString("en-US")}`}</td>
                    <td className="mono" style={{ color: "var(--text-muted)" }}>{t.edgarFailure ? `EDGAR failed: ${t.edgarFailure}` : t.failureReason ?? t.responseKeys.join(", ")}{t.plannedSalesUsd != null ? ` · 10b5-1 sales $${Math.round(t.plannedSalesUsd).toLocaleString("en-US")}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
