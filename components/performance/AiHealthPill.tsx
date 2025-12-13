"use client";

import { useEffect, useState } from "react";

type Health = {
  status: "HEALTHY" | "IDLE" | "CAPPED" | "ERROR";
  reason: string;
  timestamp: string;
};

export function AiHealthPill() {
  const [h, setH] = useState<Health | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const r = await fetch("/api/ai-health", { cache: "no-store" });
        const j = await r.json();
        if (active) setH(j);
      } catch {
        if (active)
          setH({
            status: "ERROR",
            reason: "fetch failed",
            timestamp: new Date().toISOString(),
          });
      }
    }

    load();
    const id = setInterval(load, 30000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  const status = h?.status ?? "ERROR";
  const label =
    status === "HEALTHY"
      ? "AI Healthy"
      : status === "IDLE"
      ? "AI Idle"
      : status === "CAPPED"
      ? "AI Capped"
      : "AI Error";

  const cls =
    status === "HEALTHY"
      ? "pill pill-ok"
      : status === "IDLE"
      ? "pill pill-warn"
      : status === "CAPPED"
      ? "pill pill-warn"
      : "pill pill-bad";

  return (
    <div className="ai-health-row">
      <span className={cls} title={h?.reason ?? ""}>
        {label}
      </span>
      <span className="ai-health-subtle">{h?.reason ?? ""}</span>
    </div>
  );
}
