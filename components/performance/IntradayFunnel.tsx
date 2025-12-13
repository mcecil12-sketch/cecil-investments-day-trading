"use client";

import { useEffect, useState } from "react";

type FunnelDay = {
  date: string;
  updatedAt: string;
  scansRun: number;
  candidatesFound: number;
  signalsPosted: number;
  signalsReceived: number;
  gptScored: number;
  gptScoredByModel: Record<string, number>;
  qualified: number;
  shownInApp: number;
  approvals: number;
  ordersPlaced: number;
  fills: number;
};

export function IntradayFunnel() {
  const [today, setToday] = useState<FunnelDay | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      const r = await fetch("/api/funnel-stats", { cache: "no-store" });
      const j = await r.json();
      if (active) setToday(j.today);
    }

    load();
    const id = setInterval(load, 30000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  if (!today) return null;

  const mini = today.gptScoredByModel?.["gpt-5-mini"] ?? 0;
  const pro = today.gptScoredByModel?.["gpt-5.1"] ?? 0;

  return (
    <div className="card">
      <div className="card-title">Intraday Funnel</div>
      <div className="card-subtle">
        Updated: {new Date(today.updatedAt).toLocaleTimeString()}
      </div>

      <div className="funnel-grid">
        <div className="funnel-row">
          <span>Scans run</span>
          <span className="funnel-val">{today.scansRun}</span>
        </div>
        <div className="funnel-row">
          <span>Candidates found</span>
          <span className="funnel-val">{today.candidatesFound}</span>
        </div>
        <div className="funnel-row">
          <span>Signals posted</span>
          <span className="funnel-val">{today.signalsPosted}</span>
        </div>
        <div className="funnel-row">
          <span>Signals received</span>
          <span className="funnel-val">{today.signalsReceived}</span>
        </div>
        <div className="funnel-row">
          <span>GPT scored</span>
          <span className="funnel-val">
            {today.gptScored}{" "}
            <span className="muted">
              ({mini} mini · {pro} 5.1)
            </span>
          </span>
        </div>
        <div className="funnel-row">
          <span>Qualified (≥ 8)</span>
          <span className="funnel-val">{today.qualified}</span>
        </div>
        <div className="funnel-row">
          <span>Shown in app</span>
          <span className="funnel-val">{today.shownInApp}</span>
        </div>
        <div className="funnel-row">
          <span>Approvals</span>
          <span className="funnel-val">{today.approvals}</span>
        </div>
        <div className="funnel-row">
          <span>Orders placed</span>
          <span className="funnel-val">{today.ordersPlaced}</span>
        </div>
        <div className="funnel-row">
          <span>Fills</span>
          <span className="funnel-val">{today.fills}</span>
        </div>
      </div>
    </div>
  );
}
