import { NextResponse } from "next/server";
import { computeBenchmark } from "@/lib/benchmark/engine";

export async function GET() {
  try {
    const computation = await computeBenchmark();
    return NextResponse.json(computation);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
