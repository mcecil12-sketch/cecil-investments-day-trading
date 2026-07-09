"use client";

import { useEffect, useState } from "react";

type Health = {
  status: "HEALTHY" | "DEGRADED" | "MARKET_CLOSED" | "CAPPED" | "ERROR" | "OFFLINE";
  reason: string;
  timestamp: string;
};

export function AiHealthPill() {
  const [h, setH] = useState<Health | null>(null);

  useEffect(() => {
    let active = true;

    const loadHealth = async () => {
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
    };

    const sendHeartbeat = async () => {
      try {
        await fetch("/api/ai-heartbeat", { method: "POST", cache: "no-store" });
      } catch {
        // ignore
      }
    };

    const tick = async () => {
      await sendHeartbeat();
      await loadHealth();
    };

    tick();
    const id = setInterval(tick, 30000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  const status = h?.status ?? "ERROR";
  const normalized = status.toLowerCase();

  const label = (() => {
    switch (status) {
      case "HEALTHY":
        return "AI Healthy";
      case "DEGRADED":
        return "AI Degraded";
      case "MARKET_CLOSED":
        return "Market Closed";
      case "CAPPED":
        return "AI Capped";
      case "ERROR":
        return "AI Error";
      case "OFFLINE":
        return "AI Offline";
      default:
        return "AI Status";
    }
  })();

  const statusClass = (() => {
    switch (status) {
      case "HEALTHY":
        return "ai-pill ai-pill-green";
      case "DEGRADED":
        return "ai-pill ai-pill-yellow";
      case "MARKET_CLOSED":
        return "ai-pill ai-pill-closed";
      case "CAPPED":
        return "ai-pill ai-pill-red";
      case "ERROR":
        return "ai-pill ai-pill-red ai-pill-error";
      case "OFFLINE":
        return "ai-pill ai-pill-offline";
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
