import { NextResponse } from "next/server";
import { recordHeartbeat } from "@/lib/aiMetrics";

export async function GET() {
  await recordHeartbeat();
  return NextResponse.json({ ok: true });
}

export async function POST() {
  await recordHeartbeat();
  return NextResponse.json({ ok: true });
}
