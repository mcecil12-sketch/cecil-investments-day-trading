import { NextResponse } from "next/server";
import { runAutoManage } from "@/lib/autoManage/engine";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const now = new Date().toISOString();
  try {
    const source = req.headers.get("x-run-source") || "unknown";
    const runId = req.headers.get("x-run-id") || "";

    let force = false;
    try {
      const body = await req.json().catch(() => ({}));
      force = body?.force === true;
    } catch {}

    const result = await runAutoManage({ source, runId, force });
    return NextResponse.json(result, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, now, error: err?.message || "auto_manage_failed" },
      { status: 500 }
    );
  }
}

export async function GET(req: Request) {
  const now = new Date().toISOString();
  try {
    const { searchParams } = new URL(req.url);
    const source = req.headers.get("x-run-source") || "unknown";
    const runId = req.headers.get("x-run-id") || "";

    // Support force=1, ignoreMarket=1, or force=true query params
    const force =
      searchParams.get("force") === "1" ||
      searchParams.get("force") === "true" ||
      searchParams.get("ignoreMarket") === "1";

    const result = await runAutoManage({ source, runId, force });
    return NextResponse.json(result, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, now, error: err?.message || "auto_manage_failed" },
      { status: 500 }
    );
  }
}
