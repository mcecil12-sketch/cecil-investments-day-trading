"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { AgentStatusResponse } from "@/app/api/agents/status/route";

const POLL_INTERVAL_MS = 5000;

function hasRunningAgent(statuses: AgentStatusResponse): boolean {
  return Object.values(statuses).some((status) => status === "RUNNING");
}

/**
 * Polls /api/agents/status every 5s while any agent is still RUNNING and
 * triggers a server-component refresh on any status change, so cards that
 * finish (COMPLETE/FAILED) update — findings preview included — without the
 * user reloading the page. Renders nothing; it's a background side effect
 * alongside the server-rendered agent cards.
 */
export function AgentStatusPoller({ initialStatuses }: { initialStatuses: AgentStatusResponse }) {
  const router = useRouter();
  const lastStatuses = useRef(initialStatuses);
  lastStatuses.current = initialStatuses;

  useEffect(() => {
    if (!hasRunningAgent(initialStatuses)) return;

    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const response = await fetch("/api/agents/status", { cache: "no-store" });
        if (!response.ok || cancelled) return;
        const next = (await response.json()) as AgentStatusResponse;
        if (cancelled) return;

        const changed = (Object.keys(next) as (keyof AgentStatusResponse)[]).some(
          (key) => next[key] !== lastStatuses.current[key],
        );
        if (changed) {
          lastStatuses.current = next;
          router.refresh();
        }
        if (!hasRunningAgent(next)) {
          clearInterval(interval);
        }
      } catch {
        // Transient network error — the next tick will retry.
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [initialStatuses, router]);

  return null;
}
