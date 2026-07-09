import { NextResponse } from "next/server";
import { getAiMetrics } from "@/lib/aiMetrics";
import { fetchAlpacaClock, type AlpacaClock } from "@/lib/alpacaClock";

type HealthStatus =
  | "HEALTHY"
  | "DEGRADED"
  | "CAPPED"
  | "ERROR"
  | "OFFLINE"
  | "MARKET_CLOSED";

function minutesAgo(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 60000);
}

const OFFLINE_MINUTES = 15;

function formatETTime(iso?: string) {
  if (!iso) return null;
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(new Date(iso));
}

export async function GET() {
  const metrics = await getAiMetrics();
  const mins = minutesAgo(metrics.lastHeartbeat);

  let clock: AlpacaClock | null = null;
  let marketOpen = true;
  try {
    clock = await fetchAlpacaClock();
    marketOpen = clock.is_open;
  } catch (err) {
    console.warn("[ai-health] unable to fetch market clock", err);
  }

  // Operator-friendly thresholds
  const status: HealthStatus = !marketOpen
    ? "MARKET_CLOSED"
    : mins === null || mins > OFFLINE_MINUTES
    ? "OFFLINE"
    : "HEALTHY";

  const reason =
    status === "MARKET_CLOSED"
      ? clock
        ? `market closed (next open ${formatETTime(clock.next_open) ?? "soon"})`
        : "market closed"
      : status === "OFFLINE"
      ? `last heartbeat ~${mins ?? "?"}m ago`
      : `heartbeat ~${mins}m ago`;

  const budget = {
    date: metrics.date,
    totalSpent: 0,
    perModel: {},
    alerts: { warn70: false, warn90: false },
  };

  return NextResponse.json({
    status,
    reason,
    budget,
    metrics,
    marketOpen,
    clock,
    timestamp: new Date().toISOString(),
    vercel: {
      VERCEL: process.env.VERCEL ?? null,
      VERCEL_ENV: process.env.VERCEL_ENV ?? null,
      VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      VERCEL_GIT_COMMIT_REF: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    },
  });
}
