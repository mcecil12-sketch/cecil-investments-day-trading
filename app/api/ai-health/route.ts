import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

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

export async function GET() {
  const budget = safeRead(BUDGET_PATH);
  const metrics = safeRead(METRICS_PATH);

  let status: "HEALTHY" | "IDLE" | "CAPPED" | "ERROR" = "ERROR";
  let reason = "missing budget/metrics";

  if (budget && metrics) {
    status = "HEALTHY";
    reason = "ok";

    const totalLimit = Number(process.env.AI_DAILY_LIMIT ?? 10);
    const spent = Number(budget.totalSpent ?? 0);

    if (spent >= totalLimit * 0.99) {
      status = "CAPPED";
      reason = "daily budget near cap";
    }

    try {
      const m = fs.statSync(METRICS_PATH).mtimeMs;
      const mins = (Date.now() - m) / 1000 / 60;
      if (mins > 10 && status === "HEALTHY") {
        status = "IDLE";
        reason = `no AI calls in ~${Math.round(mins)}m`;
      }
    } catch {}
  }

  return NextResponse.json({
    status,
    reason,
    budget,
    metrics,
    timestamp: new Date().toISOString(),
  });
}
