"use client";

import React, { useEffect, useState } from "react";

type ActivityEntry = {
  id: string;
  timestamp: string;
  type: string;
  tradeId?: string;
  ticker?: string;
  message?: string;
  meta?: Record<string, any>;
};

type ActivityResponse = {
  entries?: ActivityEntry[];
};

export default function ActivityPage() {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/activity");
        if (!res.ok) throw new Error(`Failed to load activity (${res.status})`);
        const data: ActivityResponse = await res.json();
        if (!cancelled) setEntries(data.entries ?? []);
      } catch (err: any) {
        if (!cancelled) setError(err?.message || "Failed to load activity");
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
    <div className="screen-container">
      <h1 className="section-title">Activity log</h1>
      {loading && <p className="muted-text">Loading…</p>}
      {error && (
        <p className="muted-text" style={{ color: "#ef4444" }}>
          {error}
        </p>
      )}
      {!loading && entries.length === 0 && (
        <p className="empty-text">No activity yet.</p>
      )}
      {entries.length > 0 && (
        <div className="card">
          <div className="card-body">
            <div className="table">
              <div
                className="table-head grid"
                style={{
                  gridTemplateColumns: "1.2fr 0.8fr 0.9fr 2fr",
                  gap: "8px",
                  fontWeight: 600,
                  color: "#cbd5e1",
                }}
              >
                <span>Time</span>
                <span>Type</span>
                <span>Ticker</span>
                <span>Message</span>
              </div>
              {entries.map((e) => (
                <div
                  key={e.id}
                  className="table-row grid"
                  style={{
                    gridTemplateColumns: "1.2fr 0.8fr 0.9fr 2fr",
                    gap: "8px",
                    padding: "10px 0",
                    borderBottom: "1px solid rgba(255,255,255,0.05)",
                  }}
                >
                  <span className="muted-text small">
                    {new Date(e.timestamp).toLocaleString()}
                  </span>
                  <span className="pill source-pill">{e.type}</span>
                  <span>{e.ticker ?? "—"}</span>
                  <span>
                    {e.message ?? "—"}
                    {e.meta?.pnl ? (
                      <span className="muted-text small">
                        {" "}
                        · {JSON.stringify(e.meta)}
                      </span>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
