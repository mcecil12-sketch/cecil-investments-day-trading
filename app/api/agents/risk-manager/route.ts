import { NextResponse } from "next/server";
import { runAndPersistRiskManager } from "@/lib/agents/runner";

export const dynamic = "force-dynamic";

export async function POST() {
  const result = await runAndPersistRiskManager();
  if (result.status === "FAILED") {
    return NextResponse.json(result, { status: 500 });
  }
  return NextResponse.json(result);
}
