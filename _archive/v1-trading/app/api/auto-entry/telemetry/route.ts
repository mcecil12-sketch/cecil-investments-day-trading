import { NextResponse } from "next/server";
import { getAutoEntryTelemetryKeys, readAutoEntryTelemetry } from "@/lib/autoEntry/telemetry";
import { getEtDateString, getEtNow, getEtNowIso } from "@/lib/time/etDate";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limitRaw = Number(url.searchParams.get("limit") ?? "50");
    const debug = String(url.searchParams.get("debug") || "") === "1";
    const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 50));
    const requestedEtDate = String(url.searchParams.get("etDate") || "").trim();

    const now = getEtNow();
    const etDate = requestedEtDate || getEtDateString(now);
    const data = await readAutoEntryTelemetry(etDate, limit, debug);
    const keys = getAutoEntryTelemetryKeys(etDate);

    return NextResponse.json(
      {
        ok: true,
        etDateUsed: etDate,
        serverNowIso: now.toISOString(),
        serverNowEtIso: getEtNowIso(now),
        dayKey: keys.dayKey,
        runsKey: keys.runsKey,
        ...data,
      },
      { status: 200 }
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? String(err) },
      { status: 500 }
    );
  }
}
