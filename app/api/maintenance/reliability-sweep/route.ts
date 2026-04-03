import { NextResponse } from "next/server";
import { reconcileOpenTrades } from "@/lib/maintenance/reconcileOpenTrades";
import { runAutoManage } from "@/lib/autoManage/engine";

export const dynamic = "force-dynamic";

type SweepBody = {
  dryRun?: boolean;
  runReconcile?: boolean;
  reconcileMax?: number;
  reconcileCloseReason?: string;
  syncToPositionOpen?: boolean;
  forceAutoManage?: boolean;
};

function isAuthorized(req: Request) {
  const token = req.headers.get("x-cron-token") || "";
  const hasSession = req.headers.get("cookie")?.includes("session=") ?? false;
  const hasToken = !!process.env.CRON_TOKEN && token === process.env.CRON_TOKEN;
  return hasSession || hasToken;
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const startedAt = new Date().toISOString();
  const runSource = req.headers.get("x-run-source") || "maintenance-reliability-sweep";
  const runId = req.headers.get("x-run-id") || "";

  const body = (await req.json().catch(() => ({}))) as SweepBody;
  const dryRun = body?.dryRun !== false;
  const runReconcile = body?.runReconcile !== false;
  const reconcileMax = Number.isFinite(Number(body?.reconcileMax))
    ? Math.max(1, Number(body?.reconcileMax))
    : 500;
  const reconcileCloseReason = String(body?.reconcileCloseReason || "reliability_sweep_reconciled_not_in_alpaca");
  const syncToPositionOpen = body?.syncToPositionOpen !== false;
  const forceAutoManage = body?.forceAutoManage === true;

  let reconcileResult: any = null;
  if (runReconcile) {
    reconcileResult = await reconcileOpenTrades({
      dryRun,
      max: reconcileMax,
      closeReason: reconcileCloseReason,
      syncToPositionOpen,
      runSource,
      runId,
    });

    if (!reconcileResult?.ok) {
      return NextResponse.json(
        {
          ok: false,
          startedAt,
          error: "reconcile_failed",
          detail: reconcileResult,
        },
        { status: 500 }
      );
    }
  }

  let autoManageResult: any = null;
  if (!dryRun && forceAutoManage) {
    autoManageResult = await runAutoManage({ source: `${runSource}:reliability-sweep`, runId, force: true });
  }

  return NextResponse.json(
    {
      ok: true,
      startedAt,
      dryRun,
      runSource,
      runId,
      reconcileRan: runReconcile,
      autoManageForced: !dryRun && forceAutoManage,
      reconcile: reconcileResult,
      autoManage: autoManageResult,
    },
    { status: 200 }
  );
}
