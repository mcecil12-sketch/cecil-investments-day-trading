import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";

const BUDGET_PATH = path.join(process.cwd(), "data", "ai-budget.json");
const METRICS_PATH = path.join(process.cwd(), "data", "ai-metrics.json");

function safeRead(p: string) {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export async function GET() {
  return NextResponse.json({
    budget: safeRead(BUDGET_PATH),
    metrics: safeRead(METRICS_PATH),
    timestamp: new Date().toISOString(),
  });
}
