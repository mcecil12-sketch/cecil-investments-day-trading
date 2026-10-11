import { NextResponse } from "next/server";
import { runAndPersistCandidateScanner } from "@/lib/agents/runner";

export const dynamic = "force-dynamic";
// These runs can chain into the Candidate Scanner and the Claude-backed weekly brief (risk-manager 504'd at the 30s default).
export const maxDuration = 120;

export async function POST() {
  const result = await runAndPersistCandidateScanner();
  if (result.status === "FAILED") {
    return NextResponse.json(result, { status: 500 });
  }
  return NextResponse.json(result);
}
