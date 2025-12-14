import { NextResponse } from "next/server";
import { heartbeatMetrics } from "@/lib/aiMetrics";

export const dynamic = "force-dynamic";

export async function POST() {
  heartbeatMetrics();
  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
  });
}
