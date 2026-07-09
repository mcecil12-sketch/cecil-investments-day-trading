"use client";

import { useEffect, useState } from "react";

type FunnelToday = {
  scansRun?: number;
  scansSkipped?: number;
  scanRunsByMode?: Record<string, number>;
  scanSkipsByMode?: Record<string, number>;
  lastScanAt?: string | null;
  lastScanMode?: string | null;
  lastScanSource?: string | null;
  lastScanRunId?: string | null;
  lastScanStatus?: string | null;
};

type FunnelResp = { ok?: boolean; today?: FunnelToday } & Record<string, any>;

type ScoreboardResp = {
  ok: boolean;
  totalScored: number;
  qualified: number;
  qualifiedRate: number;
  avgScore: number | null;
  gradeCounts: Record<string, number>;
  recent: Array<{
    ticker: string;
    createdAt?: string;
    status?: string;
    score?: number | null;
    grade?: string | null;
  }>;
} & Record<string, any>;

function pct(x: number) {
  if (!Number.isFinite(x)) return "-";
  return `${Math.round(x * 100)}%`;
}

function fmt(n: any, fallback = "-") {
  if (n === null || n === undefined) return fallback;
  return String(n);
}

function chip(text: string) {
  return (
    <span className="px-2 py-1 rounded-full border border-white/10 text-xs">
      {text}
    </span>
  );
}

export function PerformanceCards() {
  const [funnel, setFunnel] = useState<FunnelToday | null>(null);
  const [score, setScore] = useState<ScoreboardResp | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setErr(null);
        const [f, s] = await Promise.all([
          fetch("/api/funnel-stats", { cache: "no-store" }).then((r) => r.json()),
          fetch("/api/ai-scoreboard", { cache: "no-store" }).then((r) => r.json()),
        ]);

        if (cancelled) return;
        const fr = f as FunnelResp;
        setFunnel(fr?.today ?? null);
        setScore(s as ScoreboardResp);
      } catch (e: any) {
        if (cancelled) return;
        setErr(e?.message || "Failed to load performance data");
      }
    }

    load();
    const t = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="space-y-4">
      {err ? (
        <div className="rounded-2xl border border-white/10 p-4 text-sm opacity-80">
          Error: {err}
        </div>
      ) : null}

      <div className="rounded-2xl border border-white/10 p-4">
        <div className="text-sm opacity-80 mb-3">Scanner attribution</div>
        {funnel ? (
          <div className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-2">
              {chip(`runs: ${fmt(funnel.scansRun, "0")}`)}
              {chip(`skips: ${fmt(funnel.scansSkipped, "0")}`)}
              {chip(`mode: ${fmt(funnel.lastScanMode)}`)}
              {chip(`source: ${fmt(funnel.lastScanSource)}`)}
              {chip(`status: ${fmt(funnel.lastScanStatus)}`)}
            </div>
            <div className="opacity-80">
              lastScanAt: <span className="font-semibold">{fmt(funnel.lastScanAt)}</span>
            </div>
            <div className="opacity-80">
              runId: <span className="font-semibold">{fmt(funnel.lastScanRunId)}</span>
            </div>
          </div>
        ) : (
          <div className="text-sm opacity-70">Loading…</div>
        )}
      </div>

      <div className="rounded-2xl border border-white/10 p-4">
        <div className="text-sm opacity-80 mb-3">AI scoreboard</div>
        {score?.ok ? (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-2">
              {chip(`scored: ${fmt(score.totalScored, "0")}`)}
              {chip(`qualified: ${fmt(score.qualified, "0")}`)}
              {chip(`qual rate: ${pct(score.qualifiedRate)}`)}
              {chip(`avg: ${score.avgScore == null ? "-" : score.avgScore.toFixed(2)}`)}
            </div>

            <div>
              <div className="opacity-80 mb-2">Grade counts</div>
              <div className="flex flex-wrap gap-2">
                {Object.entries(score.gradeCounts || {})
                  .sort((a, b) => a[0].localeCompare(b[0]))
                  .map(([g, c]) => chip(`${g}: ${c}`))}
              </div>
            </div>

            <div>
              <div className="opacity-80 mb-2">Recent scored</div>
              <div className="space-y-1">
                {(score.recent || []).slice(0, 8).map((r, idx) => (
                  <div
                    key={`${r.ticker}-${idx}`}
                    className="flex items-center justify-between gap-3 border-b border-white/5 py-1"
                  >
                    <div className="font-semibold">{r.ticker}</div>
                    <div className="opacity-80">{r.grade ?? "-"}</div>
                    <div className="opacity-80">
                      {typeof r.score === "number" ? r.score.toFixed(1) : "-"}
                    </div>
                    <div className="opacity-70 truncate max-w-[40%]">
                      {r.status ?? "-"}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="text-sm opacity-70">Loading…</div>
        )}
      </div>
    </div>
  );
}
