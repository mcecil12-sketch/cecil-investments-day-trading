import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getAllSignals, upsertSignal, StoredSignal } from "@/lib/signalsStore";

function isLegacyTestTicker(ticker: string) {
  const upper = ticker.toUpperCase();
  return upper.startsWith("MODELVERIFY") || upper.startsWith("SCORETEST");
}

export async function POST(req: Request) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const all = await getAllSignals();

  let scanned = 0;
  let archived = 0;

  for (const s of all) {
    scanned++;

    if (s.status !== "PENDING") continue;
    if (s.source !== "manual-seed") continue;
    if (!isLegacyTestTicker(String(s.ticker ?? ""))) continue;

    await upsertSignal({
      ...s,
      status: "ARCHIVED",
      aiScore: Number(s.aiScore ?? 0),
      aiGrade: (typeof s.aiGrade === "string" && s.aiGrade.trim()) ? s.aiGrade.trim() : "F",
      aiSummary:
        "Archived legacy manual-seed test signal (created before scoring pipeline was live).",
    });

    archived++;
  }

  return NextResponse.json({ ok: true, scanned, archived });
}
