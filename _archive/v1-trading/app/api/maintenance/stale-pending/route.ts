import { NextRequest, NextResponse } from "next/server";
import { readSignals, writeSignals } from "@/lib/jsonDb";

/**
 * POST /api/maintenance/stale-pending
 *
 * Archives PENDING signals older than STALE_PENDING_HOURS (default 6 hours).
 * This prevents backlog accumulation by sweeping old pending signals that
 * were not scored within the recent window.
 *
 * Query params:
 * - staleHours: Override default stale hours (default 6)
 *
 * Returns:
 * {
 *   ok: true,
 *   matched: number,
 *   archivedCount: number,
 *   cutoffIso: string,
 *   staleHours: number
 * }
 */
export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const staleHoursParam = url.searchParams.get("staleHours");
  
  // Default to 6 hours, or use environment variable STALE_PENDING_HOURS
  const STALE_PENDING_HOURS = Number(
    staleHoursParam ?? process.env.STALE_PENDING_HOURS ?? 6
  );
  
  const now = new Date();
  const cutoffMs = now.getTime() - STALE_PENDING_HOURS * 60 * 60 * 1000;
  const cutoff = new Date(cutoffMs);
  const cutoffIso = cutoff.toISOString();
  
  // Read all signals
  const signals = await readSignals();
  
  // Find stale PENDING signals
  let matched = 0;
  let archivedCount = 0;
  
  for (const signal of signals) {
    if (signal.status === "PENDING") {
      const createdAt = new Date(signal.createdAt);
      if (createdAt < cutoff) {
        matched++;
        signal.status = "ARCHIVED";
        signal.updatedAt = now.toISOString();
        signal.archivedAt = now.toISOString();
        archivedCount++;
      }
    }
  }
  
  // Persist changes
  await writeSignals(signals);
  
  console.log("[maintenance/stale-pending] completed", {
    matched,
    archivedCount,
    cutoffIso,
    staleHours: STALE_PENDING_HOURS,
  });
  
  return NextResponse.json({
    ok: true,
    matched,
    archivedCount,
    cutoffIso,
    staleHours: STALE_PENDING_HOURS,
  });
}
