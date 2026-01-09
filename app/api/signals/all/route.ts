import { NextResponse } from "next/server";
import { readSignals } from "@/lib/jsonDb";

function normalizeSignal(s: any) {
  return {
    ...s,
    reasoning: s.reasoning ?? "",
    priority: typeof s.priority === "number" ? s.priority : 4.8,
    grade: s.grade ?? s.aiGrade ?? null,
    score: s.score ?? s.totalScore ?? s.aiScore ?? null,
  };
}

export async function GET() {
  const signals = await readSignals();
  const normalized = signals.map(normalizeSignal);
  const sortedSignals = [...normalized].sort((a: any, b: any) => {
    const ta = Date.parse(a?.createdAt ?? 0) || 0;
    const tb = Date.parse(b?.createdAt ?? 0) || 0;
    return tb - ta;
  });
  return NextResponse.json(
    { ok: true, signals: sortedSignals },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    }
  );
}
