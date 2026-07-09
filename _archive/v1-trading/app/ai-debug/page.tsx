"use client";

import { useEffect, useState } from "react";

type SignalRow = {
  id: string;
  ticker: string;
  side: string;
  status?: string;
  aiScore?: number;
  aiGrade?: string;
  aiSummary?: string;
  reasoning?: string;
  entryPrice?: number;
  stopPrice?: number;
  targetPrice?: number;
};

export default function AIDebugPage() {
  const [signals, setSignals] = useState<SignalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch(
          "/api/signals?minScore=9&status=PENDING&limit=50",
          { cache: "no-store" }
        );
        if (!res.ok) {
          throw new Error(`Failed to load signals (${res.status})`);
        }
        const data = await res.json();
        if (!cancelled) {
          setSignals(Array.isArray(data.signals) ? data.signals : []);
        }
      } catch (err: any) {
        console.error("[ai-debug] load error", err);
        if (!cancelled) setError(err?.message || "Failed to load signals");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="auto bg-neutral-950 text-neutral-100 px-4 py-6">
      <div className="max-w-6xl mx-auto space-y-4">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">
            AI Debug: Pending GPT-Approved Signals
          </h1>
          <p className="text-sm text-neutral-400">
            Showing pending signals with AI score ≥ 9 (limit 50)
          </p>
        </header>

        {loading && (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/70 px-3 py-2 text-sm">
            Loading…
          </div>
        )}

        {error && !loading && (
          <div className="rounded-lg border border-red-500/50 bg-red-900/30 px-3 py-2 text-sm text-red-100">
            {error}
          </div>
        )}

        {!loading && !error && signals.length === 0 && (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/70 px-3 py-2 text-sm text-neutral-300">
            No GPT-approved signals yet.
          </div>
        )}

        {!loading && !error && signals.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-neutral-800 bg-neutral-900/70">
            <table className="min-w-full text-sm">
              <thead className="bg-neutral-900/80 border-b border-neutral-800">
                <tr>
                  <th className="px-3 py-2 text-left text-xs uppercase text-neutral-400">
                    Ticker
                  </th>
                  <th className="px-3 py-2 text-left text-xs uppercase text-neutral-400">
                    Side
                  </th>
                  <th className="px-3 py-2 text-left text-xs uppercase text-neutral-400">
                    Status
                  </th>
                  <th className="px-3 py-2 text-left text-xs uppercase text-neutral-400">
                    Score
                  </th>
                  <th className="px-3 py-2 text-left text-xs uppercase text-neutral-400">
                    Grade
                  </th>
                  <th className="px-3 py-2 text-left text-xs uppercase text-neutral-400">
                    Entry
                  </th>
                  <th className="px-3 py-2 text-left text-xs uppercase text-neutral-400">
                    Stop
                  </th>
                  <th className="px-3 py-2 text-left text-xs uppercase text-neutral-400">
                    Target
                  </th>
                  <th className="px-3 py-2 text-left text-xs uppercase text-neutral-400">
                    AI Summary / Reasoning
                  </th>
                </tr>
              </thead>
              <tbody>
                {signals.map((s) => (
                  <tr
                    key={s.id}
                    className="border-t border-neutral-800 hover:bg-neutral-900/60"
                  >
                    <td className="px-3 py-2 font-semibold">{s.ticker}</td>
                    <td className="px-3 py-2">{s.side}</td>
                    <td className="px-3 py-2">{s.status || "PENDING"}</td>
                    <td className="px-3 py-2">
                      {s.aiScore != null ? s.aiScore.toFixed(2) : "—"}
                    </td>
                    <td className="px-3 py-2">{s.aiGrade ?? "—"}</td>
                    <td className="px-3 py-2">
                      {s.entryPrice != null ? s.entryPrice.toFixed(2) : "—"}
                    </td>
                    <td className="px-3 py-2">
                      {s.stopPrice != null ? s.stopPrice.toFixed(2) : "—"}
                    </td>
                    <td className="px-3 py-2">
                      {s.targetPrice != null ? s.targetPrice.toFixed(2) : "—"}
                    </td>
                    <td className="px-3 py-2 text-neutral-300">
                      {s.aiSummary || s.reasoning || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
