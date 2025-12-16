import { NextResponse } from "next/server";
import { writeAiHeartbeat } from "@/lib/aiMetrics";

export const dynamic = "force-dynamic";

const CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
  Pragma: "no-cache",
  Expires: "0",
};

export async function GET() {
  await writeAiHeartbeat();
  return NextResponse.json({ ok: true }, { headers: CACHE_HEADERS });
}

export async function POST() {
  return GET();
}
