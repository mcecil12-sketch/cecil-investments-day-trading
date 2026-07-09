import { NextResponse } from "next/server";
import { computeBenchmark } from "@/lib/benchmark/engine";
import { persistBenchmarkResults } from "@/lib/benchmark/persist";

export async function GET() {
  try {
    const computation = await computeBenchmark();
    await persistBenchmarkResults(computation);
    return NextResponse.json(computation);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
