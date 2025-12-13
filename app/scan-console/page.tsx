"use client";

import React, { useState } from "react";

type ScanMode = "vwap-full" | "breakout" | "compression" | "premarket-vwap";

type ScanResult = {
  ok: boolean;
  mode: ScanMode;
  url: string;
  statusCode?: number;
  bodySnippet?: string;
  error?: string;
};

const SCAN_ENDPOINT_BASE = "/api/scan";

const MODE_LABELS: Record<ScanMode, string> = {
  "vwap-full": "VWAP Full-Universe",
  breakout: "Breakout Scanner",
  compression: "Compression / NR7",
  "premarket-vwap": "Pre-market VWAP",
};

export default function ScanConsolePage() {
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState<ScanResult[]>([]);
  const [limit, setLimit] = useState<number>(200);
  const [log, setLog] = useState<string>("");

  async function runScan(mode: ScanMode) {
    if (isRunning) return;

    setIsRunning(true);
    setLog(
      (prev) =>
        prev +
        `\n[${new Date().toLocaleTimeString()}] Starting scan: ${MODE_LABELS[mode]} (${mode})`
    );
    try {
      const params = new URLSearchParams();
      params.set("mode", mode);

      if (mode === "vwap-full") {
        params.set("limit", String(limit));
      }

      const url = `${SCAN_ENDPOINT_BASE}?${params.toString()}`;
      const res = await fetch(url);
      const text = await res.text();

      const snippet = text.slice(0, 400);

      setResults((prev) => [
        {
          ok: res.ok,
          mode,
          url,
          statusCode: res.status,
          bodySnippet: snippet,
        },
        ...prev,
      ]);

      setLog(
        (prev) =>
          prev +
          `\n[${new Date().toLocaleTimeString()}] Completed: ${MODE_LABELS[mode]} (${mode}) → ${res.status}`
      );
    } catch (err: any) {
      console.error("Scan error", err);
      setResults((prev) => [
        {
          ok: false,
          mode,
          url: `${SCAN_ENDPOINT_BASE}?mode=${mode}`,
          error: err?.message ?? String(err),
        },
        ...prev,
      ]);
      setLog(
        (prev) =>
          prev +
          `\n[${new Date().toLocaleTimeString()}] ERROR on ${MODE_LABELS[mode]}: ${
            err?.message ?? String(err)
          }`
      );
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <main className="auto bg-slate-950 text-slate-50 px-4 py-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">Scan Console</h1>
          <p className="text-sm text-slate-400">
            Trigger VWAP, breakout, compression/NR7, and pre-market VWAP scans. Results are logged below.
          </p>
        </header>

        <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">VWAP Full-Universe</div>
                <div className="text-xs text-slate-400">
                  Scans a filtered universe (price/volume) with optional limit for symbols.
                </div>
              </div>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1 text-xs text-slate-400">
                  <span>Limit</span>
                  <input
                    type="number"
                    min={50}
                    max={2000}
                    className="w-20 rounded-md bg-slate-950 border border-slate-700 px-2 py-1 text-xs"
                    value={limit}
                    onChange={(e) => setLimit(Number(e.target.value) || 200)}
                  />
                </label>
                <button
                  onClick={() => runScan("vwap-full")}
                  disabled={isRunning}
                  className="rounded-lg border border-emerald-500 px-3 py-1.5 text-xs font-medium hover:bg-emerald-500/10 disabled:opacity-50"
                >
                  Run VWAP Full
                </button>
              </div>
            </div>

            <div className="h-px bg-slate-800" />

            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">Breakout Scanner</div>
                <div className="text-xs text-slate-400">
                  Looks for symbols breaking out above recent ranges with volume confirmation.
                </div>
              </div>
              <button
                onClick={() => runScan("breakout")}
                disabled={isRunning}
                className="rounded-lg border border-sky-500 px-3 py-1.5 text-xs font-medium hover:bg-sky-500/10 disabled:opacity-50"
              >
                Run Breakout
              </button>
            </div>

            <div className="h-px bg-slate-800" />

            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">Compression / NR7</div>
                <div className="text-xs text-slate-400">
                  Finds symbols with very tight ranges (inside bars / NR7) for potential expansion.
                </div>
              </div>
              <button
                onClick={() => runScan("compression")}
                disabled={isRunning}
                className="rounded-lg border border-amber-500 px-3 py-1.5 text-xs font-medium hover:bg-amber-500/10 disabled:opacity-50"
              >
                Run Compression
              </button>
            </div>

            <div className="h-px bg-slate-800" />

            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium">Pre-market VWAP</div>
                <div className="text-xs text-slate-400">
                  Focuses on pre-market action vs VWAP for gap setups.
                </div>
              </div>
              <button
                onClick={() => runScan("premarket-vwap")}
                disabled={isRunning}
                className="rounded-lg border border-purple-500 px-3 py-1.5 text-xs font-medium hover:bg-purple-500/10 disabled:opacity-50"
              >
                Run Pre-market
              </button>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-slate-200">Recent scan runs</h2>
          <div className="space-y-2 max-h-64 overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900/60 p-3 text-xs">
            {results.length === 0 && (
              <div className="text-slate-500">No scans run yet.</div>
            )}
            {results.map((r, idx) => (
              <div
                key={idx}
                className="rounded-xl border border-slate-700 bg-slate-950/60 p-2 space-y-1"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="font-medium">
                    {MODE_LABELS[r.mode]} ({r.mode})
                  </div>
                  <div
                    className={`px-2 py-0.5 rounded-full text-[10px] ${
                      r.ok
                        ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/40"
                        : "bg-rose-500/10 text-rose-300 border border-rose-500/40"
                    }`}
                  >
                    {r.ok ? "OK" : "ERROR"}
                  </div>
                </div>
                <div className="text-slate-400 break-all">
                  URL: <span className="font-mono">{r.url}</span>
                </div>
                {r.statusCode && (
                  <div className="text-slate-400">
                    Status: <span className="font-mono">{r.statusCode}</span>
                  </div>
                )}
                {r.error && <div className="text-rose-300">Error: {r.error}</div>}
                {r.bodySnippet && (
                  <pre className="mt-1 max-h-32 overflow-y-auto rounded-lg bg-slate-950/80 p-2 text-[10px] text-slate-300">
                    {r.bodySnippet}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-slate-200">Log</h2>
          <textarea
            className="w-full min-h-[120px] rounded-2xl border border-slate-800 bg-slate-900/60 p-2 text-xs font-mono text-slate-300"
            readOnly
            value={log.trimStart()}
          />
        </section>
      </div>
    </main>
  );
}
