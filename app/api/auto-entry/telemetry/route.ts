import { NextResponse } from "next/server";
import { readAutoEntryTelemetry } from "@/lib/autoEntry/telemetry";

export const dynamic = "force-dynamic";

function etDateString(d: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const da = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${da}`;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limitRaw = Number(url.searchParams.get("limit") ?? "50");
    const debug = String(url.searchParams.get("debug") || "") === "1";
    const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 50));

    const etDate = etDateString(new Date());
    const data = await readAutoEntryTelemetry(etDate, limit, debug);

    return NextResponse.json({ ok: true, ...data }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? String(err) },
      { status: 500 }
    );
  }
}
