"use client";

import { useEffect } from "react";

export function AiHeartbeatPing() {
  useEffect(() => {
    const ping = () => {
      fetch("/api/ai-heartbeat", { method: "POST" }).catch(() => {});
    };

    ping();
    const id = setInterval(ping, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  return null;
}
