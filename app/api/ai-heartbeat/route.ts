import { NextResponse } from "next/server";
import { heartbeatMetrics } from "../../../lib/aiMetrics";

export const dynamic = "force-dynamic";

/**
 * NOTE:
 * - Browsers and your UI fetches will typically call this with GET
 * - We also allow POST so you can trigger it from scripts if you want
 * - This endpoint should be public (allowlisted in middleware)
 */

export async function GET() {
  try {
    const metrics = await heartbeatMetrics();
    return NextResponse.json({ ok: true, metrics, timestamp: new Date().toISOString() });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e), timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}

export async function POST() {
  return GET();
}
