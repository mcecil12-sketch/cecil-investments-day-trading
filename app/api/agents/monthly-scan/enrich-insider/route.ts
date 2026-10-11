import { NextRequest, NextResponse } from "next/server";
import { enrichInsiderForLatestMonthlyScan } from "@/lib/agents/insiderEnrichment";

export const dynamic = "force-dynamic";
export const maxDuration = 240;

/**
 * Completes a partial insider-enrichment pass on the latest monthly batch
 * without re-running the scan — idempotent: only rows with insiderFetchedAt
 * null are touched (`?retryFailed=1` also retries rows that were attempted
 * but came back empty-handed). Behind the app-wide PIN gate (middleware.ts).
 */
export async function POST(request: NextRequest) {
  const result = await enrichInsiderForLatestMonthlyScan({
    startedAtMs: Date.now(),
    retryFailed: request.nextUrl.searchParams.get("retryFailed") === "1",
  });
  return NextResponse.json(result, { status: result.error ? 500 : 200 });
}
