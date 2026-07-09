import { NextResponse } from "next/server";
import { reconcileOpenTrades } from "@/lib/maintenance/reconcileOpenTrades";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const token = req.headers.get("x-cron-token") || "";

  const hasSession = req.headers.get("cookie")?.includes("session=") ?? false;
  const hasToken = !!process.env.CRON_TOKEN && token === process.env.CRON_TOKEN;

  if (!hasSession && !hasToken) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const dryRun = body?.dryRun === true;
  const max = Number.isFinite(body?.max) ? Math.max(1, Number(body.max)) : 500;
  const closeReason = String(body?.closeReason || "reconciled_not_in_alpaca");
  const syncToPositionOpen = body?.syncToPositionOpen !== false;

  const runSource = req.headers.get("x-run-source") || "maintenance-api";
  const runId = req.headers.get("x-run-id") || "";

  const result = await reconcileOpenTrades({
    dryRun,
    max,
    closeReason,
    syncToPositionOpen,
    runSource,
    runId,
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: result.error,
        detail: result.detail,
        message: "Cannot reconcile without broker truth",
      },
      { status: 500 }
    );
  }

  return NextResponse.json(result, { status: 200 });
}
