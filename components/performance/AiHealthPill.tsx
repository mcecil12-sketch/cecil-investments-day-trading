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
  const normalized = status.toLowerCase();

  const label =
    status === "HEALTHY"
      ? "AI Healthy"
      : status === "IDLE"
      ? "AI Idle"
      : status === "CAPPED"
      ? "AI Capped"
      : status === "ERROR"
      ? "AI Error"
      : "AI Status";

  const statusClass = (() => {
    switch (normalized) {
      case "healthy":
        return "ai-pill ai-pill-green";
      case "idle":
        return "ai-pill ai-pill-blue";
      case "throttled":
        return "ai-pill ai-pill-yellow";
      case "capped":
        return "ai-pill ai-pill-red";
      case "error":
        return "ai-pill ai-pill-red ai-pill-error";
      case "offline":
      default:
        return "ai-pill ai-pill-offline";
    }
  })();

  return (
    <div className="ai-health-row">
      <span className={statusClass} title={h?.reason ?? ""}>
        {status === "ERROR" ? "❌ AI Error" : label}
      </span>
      <span className="ai-health-subtle">{h?.reason ?? ""}</span>
    </div>
  );
}
