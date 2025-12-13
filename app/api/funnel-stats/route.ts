import { NextResponse } from "next/server";
import { readTodayFunnel } from "@/lib/funnelMetrics";

export const dynamic = "force-dynamic";

export async function GET() {
  const today = readTodayFunnel();
  return NextResponse.json({
    today,
    timestamp: new Date().toISOString(),
  });
}
