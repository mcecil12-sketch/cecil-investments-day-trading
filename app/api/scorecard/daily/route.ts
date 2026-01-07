import { NextResponse } from "next/server";
import { readDailyScorecard } from "@/lib/scorecard/redis";

export const dynamic = "force-dynamic";

function dateETNow(): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date()); // YYYY-MM-DD
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const dateET = searchParams.get("dateET") || dateETNow();

  const res = await readDailyScorecard(dateET);
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.error, key: res.key }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    dateET,
    found: res.found,
    key: res.key,
    scorecard: res.card,
  });
}

