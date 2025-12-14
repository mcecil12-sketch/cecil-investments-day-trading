import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { fetchAlpacaClock } from "../../../lib/alpacaClock";

export const dynamic = "force-dynamic";

const BUDGET_PATH = path.join(process.cwd(), "data", "ai-budget.json");
const METRICS_PATH = path.join(process.cwd(), "data", "ai-metrics.json");

function safeRead(p: string) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function minutesSinceFileWrite(p: string): number | null {
  try {
    const m = fs.statSync(p).mtimeMs;
    return (Date.now() - m) / 1000 / 60;
  } catch {
    return null;
  }
}

function isRegularMarketOpenET(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");

  const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(wd);
  const t = hour * 60 + minute;
  const open = 9 * 60 + 30;
  const close = 16 * 60;

  return isWeekday && t >= open && t < close;
}

/**
 * Simple US regular-hours check (ET): Mon–Fri, 9:30–16:00.
 * This ignores holidays. If you want holiday-accurate, we’ll call Alpaca market clock.
 */
export async function GET() {
  let status:
    | "HEALTHY"
    | "DEGRADED"
    | "MARKET_CLOSED"
    | "CAPPED"
    | "ERROR"
    | "OFFLINE" = "OFFLINE";

  let reason = "heartbeat stale or missing";

  const budget = safeRead(BUDGET_PATH);
  const metrics = safeRead(METRICS_PATH);

  const mins = minutesSinceFileWrite(METRICS_PATH);
  const alive = mins !== null && mins <= 3;

  if (!alive) {
    return NextResponse.json({
      status: "OFFLINE",
      reason: mins === null ? "ai-metrics missing" : `last heartbeat ~${Math.round(mins)}m ago`,
      budget,
      metrics,
      timestamp: new Date().toISOString(),
    });
  }

  let marketOpen = false;
  let clockReason = "";
  try {
    const clock = await fetchAlpacaClock();
    marketOpen = clock.is_open;
    clockReason = clock.is_open
      ? "market open per Alpaca clock"
      : `market closed until ${clock.next_open}`;
  } catch (err) {
    marketOpen = isRegularMarketOpenET();
    clockReason = "used ET hours fallback";
  }

  if (!marketOpen) {
    return NextResponse.json({
      status: "MARKET_CLOSED",
      reason: `US market closed (${clockReason})`,
      budget,
      metrics,
      timestamp: new Date().toISOString(),
    });
  }

  if (!budget || !metrics) {
    return NextResponse.json({
      status: "DEGRADED",
      reason: "alive but missing budget/metrics snapshot",
      budget,
      metrics,
      timestamp: new Date().toISOString(),
    });
  }

  const totalLimit = Number(process.env.AI_DAILY_LIMIT ?? 10);
  const spent = Number(budget.totalSpent ?? 0);
  if (spent >= totalLimit * 0.99) {
    status = "CAPPED";
    reason = "daily budget near cap";
    return NextResponse.json({ status, reason, budget, metrics, timestamp: new Date().toISOString() });
  }

  const callsToday = Number(metrics.calls ?? 0);
  if (!callsToday || callsToday <= 0) {
    status = "DEGRADED";
    reason = "market open but no GPT calls today";
  } else {
    status = "HEALTHY";
    reason = "ok";
  }

  return NextResponse.json({
    status,
    reason,
    budget,
    metrics,
    timestamp: new Date().toISOString(),
  });
}
