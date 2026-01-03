import { NextResponse } from "next/server";
import { readAutoManageTelemetry } from "@/lib/autoManage/telemetry";

export const dynamic = "force-dynamic";

export async function GET() {
  const t = await readAutoManageTelemetry(50);
  const s: any = t.summary || {};
  return NextResponse.json({
    ok: true,
    runs: Number(s.runs || 0),
    success: Number(s.success || 0),
    fail: Number(s.fail || 0),
    skipped: Number(s.skipped || 0),
    lastRunAt: s.lastRunAt || "",
    lastOutcome: s.lastOutcome || "",
    lastReason: s.lastReason || "",
    lastSource: s.lastSource || "",
    lastRunId: s.lastRunId || "",
    byReason: Object.fromEntries(
      Object.entries(s)
        .filter(([k]) => k.startsWith("reason:"))
        .map(([k, v]) => [k.slice(7), Number(v || 0)])
    ),
  });
}
