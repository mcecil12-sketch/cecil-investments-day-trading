import { NextResponse } from "next/server";
import { readSignals } from "@/lib/jsonDb";

export async function GET() {
  const signals = await readSignals();

  const out = signals.map((s) => ({
    ...s,
    reasoning: s.reasoning ?? "",
    priority: typeof s.priority === "number" ? s.priority : 4.8,
  }));

  return NextResponse.json({ signals: out });
}
