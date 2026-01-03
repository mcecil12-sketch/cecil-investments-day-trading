import { NextResponse } from "next/server";
import { alpacaRequest } from "@/lib/alpaca";
import { getAutoConfig } from "@/lib/autoEntry/config";
import { getAutoManageConfig } from "@/lib/autoManage/config";
import { readAutoManageTelemetry } from "@/lib/autoManage/telemetry";

export const dynamic = "force-dynamic";

async function getClockSafe() {
  const r = await alpacaRequest({ method: "GET", path: "/v2/clock" });
  if (!r.ok) return null;
  try {
    return JSON.parse(r.text || "null");
  } catch {
    return null;
  }
}

export async function GET() {
  const now = new Date().toISOString();

  const pause = process.env.PAUSE_AUTOTRADING === "1";
  const autoEntry = getAutoConfig();
  const autoManage = getAutoManageConfig();

  const clock = await getClockSafe();
  const marketClosed = clock && typeof clock.is_open === "boolean" ? !clock.is_open : null;

  const amTel = await readAutoManageTelemetry(5);

  const reasons: string[] = [];
  if (pause) reasons.push("paused");
  if (marketClosed === true) reasons.push("market_closed");
  if (!autoEntry.enabled) reasons.push("auto_entry_disabled");
  if (!autoManage.enabled) reasons.push("auto_manage_disabled");

  return NextResponse.json({
    ok: true,
    now,
    market: clock,
    flags: {
      pause,
      autoEntryEnabled: autoEntry.enabled,
      autoEntryPaperOnly: autoEntry.paperOnly,
      autoEntryMaxOpen: autoEntry.maxOpen,
      autoEntryMaxPerDay: autoEntry.maxPerDay,
      autoManageEnabled: autoManage.enabled,
      autoManageEodFlatten: autoManage.eodFlatten,
      autoManageTrailEnabled: autoManage.trailEnabled,
      autoManageTrailStartR: autoManage.trailStartR,
      autoManageTrailPct: autoManage.trailPct,
    },
    reasons,
    autoManageTelemetry: amTel,
  });
}
