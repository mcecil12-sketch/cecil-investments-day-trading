import { NextResponse } from "next/server";
import { getAiMetrics } from "@/lib/aiMetrics";

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

export async function GET() {
  const metrics = await getAiMetrics();
  const mins = minutesAgo(metrics.lastHeartbeat);

  // Operator-friendly thresholds
  const OFFLINE_MIN = 15;

  const status: HealthStatus =
    mins === null
      ? "OFFLINE"
      : mins > OFFLINE_MIN
      ? "OFFLINE"
      : "HEALTHY";

  const reason =
    status === "OFFLINE"
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
    timestamp: new Date().toISOString(),
  });
}
