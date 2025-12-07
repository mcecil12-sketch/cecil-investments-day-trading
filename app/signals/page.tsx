"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { TradeSide } from "../tradingContext";

type IncomingSignal = {
  id?: string;
  ticker: string;
  side: TradeSide;
  entryPrice: number;
  stopPrice?: number | null;
  targetPrice?: number | null;
  reasoning?: string;
  source?: string;
  createdAt?: string;
  priority?: number;
  trendScore?: number;
  liquidityScore?: number;
  playbookScore?: number;
  volumeScore?: number;
  catalystScore?: number;
};

type SignalsResponse = {
  signals: IncomingSignal[];
};

export default function SignalsPage() {
  const [signals, setSignals] = useState<IncomingSignal[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    async function fetchSignals() {
      setLoading(true);
      setErrorMsg(null);
      try {
        const res = await fetch("/api/signals/all");
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as SignalsResponse;
        setSignals(data.signals || []);
      } catch (err: any) {
        console.error("Error fetching /api/signals/all", err);
        setErrorMsg(err?.message || "Failed to load signals");
      } finally {
        setLoading(false);
      }
    }

    fetchSignals();
  }, []);

  return (
    <div className="today-container">
      <section className="card">
        <h2 className="section-title">Signal debugger</h2>
        <p className="muted-text">
          Inspect all raw signals, their A+ priority score (0–10), and quality
          factors. The{" "}
          <code>/today</code> page still only shows A+ setups with priority{" "}
          <strong>&ge; 9</strong>.
        </p>
        <p className="muted-text small">
          <Link href="/today">Go to Today / approvals →</Link>
        </p>
      </section>

      <section className="cards">
        <h3 className="section-title">All signals</h3>
        {loading && <p className="muted-text">Loading signals…</p>}
        {errorMsg && (
          <p className="muted-text neg">Error loading signals: {errorMsg}</p>
        )}
        {!loading && !errorMsg && signals.length === 0 && (
          <p className="empty-text">No signals found in store yet.</p>
        )}

        {signals.map((signal) => {
          const pri = typeof signal.priority === "number" ? signal.priority : 0;
          const qualityLabel =
            pri >= 9
              ? "A+"
              : pri >= 7
              ? "A"
              : pri >= 5
              ? "B"
              : pri > 0
              ? "C"
              : "-";

          const created =
            signal.createdAt && !Number.isNaN(Date.parse(signal.createdAt))
              ? new Date(signal.createdAt).toLocaleString()
              : "—";

          return (
            <div key={signal.id ?? `${signal.ticker}-${created}`} className="card">
              <div className="card-header">
                <div className="pill-row">
                  <span className="pill ticker-pill">{signal.ticker}</span>
                  <span
                    className={`pill side-pill ${signal.side.toLowerCase()}`}
                  >
                    {signal.side}
                  </span>
                  {signal.source && (
                    <span className="pill source-pill">{signal.source}</span>
                  )}
                  <span className="pill priority-pill">
                    P{pri.toFixed(1)} · {qualityLabel}
                  </span>
                </div>
                <div className="muted-text small">Created: {created}</div>
              </div>

              <div className="card-body grid grid-2">
                <div>
                  <div className="label">Entry</div>
                  <div className="value">
                    {signal.entryPrice.toFixed(2)}
                  </div>
                </div>
                <div>
                  <div className="label">Stop</div>
                  <div className="value">
                    {signal.stopPrice != null
                      ? signal.stopPrice.toFixed(2)
                      : "—"}
                  </div>
                </div>
                <div>
                  <div className="label">Target</div>
                  <div className="value">
                    {signal.targetPrice != null
                      ? signal.targetPrice.toFixed(2)
                      : "—"}
                  </div>
                </div>
                <div>
                  <div className="label">Priority score</div>
                  <div className="value">P{pri.toFixed(1)}</div>
                </div>
              </div>

              <div className="card-body grid grid-2">
                <div>
                  <div className="label">Trend score</div>
                  <div className="value">
                    {signal.trendScore != null
                      ? signal.trendScore.toFixed(2)
                      : "—"}
                  </div>
                </div>
                <div>
                  <div className="label">Liquidity score</div>
                  <div className="value">
                    {signal.liquidityScore != null
                      ? signal.liquidityScore.toFixed(2)
                      : "—"}
                  </div>
                </div>
                <div>
                  <div className="label">Playbook score</div>
                  <div className="value">
                    {signal.playbookScore != null
                      ? signal.playbookScore.toFixed(2)
                      : "—"}
                  </div>
                </div>
                <div>
                  <div className="label">Volume score</div>
                  <div className="value">
                    {signal.volumeScore != null
                      ? signal.volumeScore.toFixed(2)
                      : "—"}
                  </div>
                </div>
                <div>
                  <div className="label">Catalyst score</div>
                  <div className="value">
                    {signal.catalystScore != null
                      ? signal.catalystScore.toFixed(2)
                      : "—"}
                  </div>
                </div>
              </div>

              {signal.reasoning && (
                <div className="card-body">
                  <div className="label">Reasoning</div>
                  <div className="muted-text">{signal.reasoning}</div>
                </div>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}
