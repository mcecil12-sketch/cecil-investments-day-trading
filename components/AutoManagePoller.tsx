"use client";

import { useEffect } from "react";

/**
 * Lightweight client-side poller to trigger /api/auto-manage every 60s.
 * Returns null; include in pages where you want background auto-manage ticks.
 */
export function AutoManagePoller() {
  useEffect(() => {
    const interval = setInterval(() => {
      fetch("/api/auto-manage").catch((err) => {
        console.error("auto-manage error", err);
      });
    }, 60_000); // 60s

    return () => clearInterval(interval);
  }, []);

  return null;
}
