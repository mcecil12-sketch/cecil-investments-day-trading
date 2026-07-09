import { NextResponse } from "next/server";
import { touchHeartbeat } from "@/lib/aiMetrics";

export const dynamic = "force-dynamic";

const CACHE_HEADERS = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  Expires: "0",
};

async function handleHeartbeat() {
  const nowIso = new Date().toISOString();
  try {
    const updated = await touchHeartbeat(nowIso);
    return NextResponse.json(
      { ok: true, nowIso, lastHeartbeat: updated.lastHeartbeat },
      { headers: CACHE_HEADERS }
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, nowIso, error: err?.message ?? String(err) },
      { status: 500, headers: CACHE_HEADERS }
    );
  }
}

export async function GET() {
  return handleHeartbeat();
}

export async function POST() {
  return handleHeartbeat();
}
