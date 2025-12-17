"use client";

import { useEffect } from "react";

type Props = {
  intervalMs?: number;
};

export function HeartbeatPoller({ intervalMs = 60_000 }: Props) {
  useEffect(() => {
    let alive = true;

    async function beat() {
      try {
        await fetch("/api/ai-heartbeat", {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "ui-poller" }),
        });
      } catch {
        // intentionally silent; ai-health handles offline diagnostics
      }
    }

    beat();

    const id = setInterval(() => {
      if (!alive) return;
      beat();
    }, intervalMs);

    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [intervalMs]);

  return null;
}
