import { NextResponse } from "next/server";
import { getTradingConfig } from "@/lib/tradingConfig";
export const dynamic = "force-dynamic";
export async function GET() {
  return NextResponse.json({ ok: true, config: getTradingConfig() });
}
