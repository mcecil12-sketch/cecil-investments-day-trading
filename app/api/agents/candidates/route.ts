import { NextResponse } from "next/server";
import { runAndPersistCandidateScanner } from "@/lib/agents/runner";

export const dynamic = "force-dynamic";

export async function POST() {
  const result = await runAndPersistCandidateScanner();
  if (result.status === "FAILED") {
    return NextResponse.json(result, { status: 500 });
  }
  return NextResponse.json(result);
}
