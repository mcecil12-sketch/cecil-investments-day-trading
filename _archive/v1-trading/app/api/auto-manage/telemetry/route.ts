import { NextResponse } from "next/server";
import { readAutoManageTelemetry } from "@/lib/autoManage/telemetry";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const u = new URL(req.url);
  const limit = Math.max(1, Math.min(200, Number(u.searchParams.get("limit") || "50")));
  const data = await readAutoManageTelemetry(limit);
  return NextResponse.json(data);
}
