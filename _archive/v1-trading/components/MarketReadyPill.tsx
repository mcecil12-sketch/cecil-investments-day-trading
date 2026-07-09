"use client";

import { useEffect, useState } from "react";

type Readiness = {
  ok: boolean;
  ready: boolean;
  timestamp?: string;
  etDate?: string;
  market?: { status?: string };
  ai?: { status?: string };
  scanner?: {
    lastScanAt?: string | null;
    lastScanMode?: string | null;
    lastScanSource?: string | null;
    lastScanStatus?: string | null;
    minsSinceLastScan?: number | null;
  };
  today?: {
    scored?: number;
    maxScore?: number | null;
    avgScore?: number | null;
    lastScoredAt?: string | null;
  };
  reasons?: string[];
};

function pillClass(ok: boolean) {
  return ok
    ? "inline-flex items-center rounded-full border px-3 py-1 text-sm border-emerald-500 bg-emerald-500/10 text-emerald-300"
    : "inline-flex items-center rounded-full border px-3 py-1 text-sm border-rose-500 bg-rose-500/10 text-rose-300";
}

export function MarketReadyPill() {
  const [data, setData] = useState<Readiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/readiness", { cache: "no-store" });
      const json = (await resp.json()) as Readiness;
      if (!resp.ok || !json?.ok) {
        setError(json?.reasons?.[0] || `readiness_failed_${resp.status}`);
        setData(null);
      } else {
        setData(json);
      }
    } catch (e: any) {
      setError(e?.message || "readiness_fetch_failed");
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const id = window.setInterval(load, 30_000);
    return () => window.clearInterval(id);
  }, []);

  const ready = Boolean(data?.ready);

  return (
    <div className="rounded-2xl border border-slate-800/60 bg-slate-950/40 p-4 shadow-lg">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-400">Market ready</div>
          <div className="mt-1 flex items-center gap-2">
            {loading ? (
              <span className="inline-flex items-center rounded-full border px-3 py-1 text-sm border-slate-600 text-slate-400">
                Checking…
              </span>
            ) : error ? (
              <span className="inline-flex items-center rounded-full border px-3 py-1 text-sm border-rose-500 text-rose-300">
                ERROR
              </span>
            ) : (
              <span className={pillClass(ready)}>{ready ? "READY" : "NOT READY"}</span>
            )}
            <div className="text-sm opacity-80">
              Market: {data?.market?.status || "?"} • AI: {data?.ai?.status || "?"}
            </div>
          </div>
        </div>

        <button
          onClick={load}
          className="rounded-xl border border-slate-700 px-3 py-1 text-xs uppercase tracking-wide text-slate-200 hover:border-slate-500"
        >
          Refresh
        </button>
      </div>

      <div className="mt-3 grid gap-2 text-sm opacity-80">
        <div>
          <span className="opacity-60">Scanner:</span>{" "}
          {data?.scanner?.lastScanMode || "?"} / {data?.scanner?.lastScanSource || "?"} /{" "}
          {data?.scanner?.lastScanStatus || "?"}{" "}
          {data?.scanner?.minsSinceLastScan != null
            ? `(${data.scanner.minsSinceLastScan.toFixed(1)}m ago)`
            : ""}
        </div>
        <div>
          <span className="opacity-60">Today scored:</span>{" "}
          {data?.today?.scored ?? "?"} • max{" "}
          {data?.today?.maxScore != null ? data.today.maxScore.toFixed(2) : "?"} • avg{" "}
          {data?.today?.avgScore != null ? data.today.avgScore.toFixed(2) : "?"}
          {data?.today?.lastScoredAt ? ` • last ${new Date(data.today.lastScoredAt).toLocaleTimeString()}` : ""}
        </div>
        {!loading && !ready && data?.reasons?.length ? (
          <div className="rounded-xl border border-rose-800/40 bg-rose-800/10 p-3 text-xs text-rose-100">
            <p className="text-[11px] uppercase tracking-wide">Why not ready</p>
            <ul className="list-disc pl-5">
              {data.reasons.slice(0, 4).map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {error ? (
          <div className="rounded-xl border border-rose-600/60 bg-rose-800/20 p-3 text-xs text-rose-200">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
