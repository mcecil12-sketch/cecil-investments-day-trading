import { NextResponse } from "next/server";
import { readTodayFunnel } from "@/lib/funnelRedis";

export const dynamic = "force-dynamic";

export async function GET() {
  const funnel = await readTodayFunnel();
  return NextResponse.json({
    ok: true,
    scannerTokenConfigured: Boolean(process.env.SCANNER_TOKEN),
    today: funnel,
  });
}
