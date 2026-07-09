import { NextRequest, NextResponse } from "next/server";
import { readSignals, writeSignals } from "@/lib/jsonDb";

/**
 * POST /api/signals/archive
 *
 * Archives signals matching status and olderThan criteria by setting status="ARCHIVED"
 * and updating updatedAt timestamp.
 *
 * Query params:
 * - status: Filter by status (e.g., "PENDING", "SCORING", "ERROR")
 * - olderThanDays: Archive signals older than N days
 * - olderThanHours: Archive signals older than N hours (overrides days)
 * - olderThanMinutes: Archive signals older than N minutes (overrides hours and days)
 *
 * Returns:
 * {
 *   ok: true,
 *   matched: number,
 *   archivedCount: number,
 *   cutoffIso: string,
 *   statusFilter: string | null
 * }
 */
export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const statusFilter = url.searchParams.get("status");
  const olderThanDaysRaw = url.searchParams.get("olderThanDays");
  const olderThanHoursRaw = url.searchParams.get("olderThanHours");
  const olderThanMinutesRaw = url.searchParams.get("olderThanMinutes");

  // Compute cutoff: minutes overrides hours overrides days
  const now = new Date();
  let cutoffMs = now.getTime();

  if (olderThanMinutesRaw != null) {
    const minutes = Number(olderThanMinutesRaw);
    if (Number.isFinite(minutes) && minutes > 0) {
      cutoffMs = now.getTime() - minutes * 60 * 1000;
    }
  } else if (olderThanHoursRaw != null) {
    const hours = Number(olderThanHoursRaw);
    if (Number.isFinite(hours) && hours > 0) {
      cutoffMs = now.getTime() - hours * 60 * 60 * 1000;
    }
  } else if (olderThanDaysRaw != null) {
    const days = Number(olderThanDaysRaw);
    if (Number.isFinite(days) && days > 0) {
      cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000;
    }
  } else {
    // No time filter provided - default to archiving signals older than 7 days
    cutoffMs = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  }

  const cutoff = new Date(cutoffMs);
  const cutoffIso = cutoff.toISOString();

  // Read all signals
  const signals = await readSignals();

  // Find matching signals
  let matched = 0;
  let archivedCount = 0;

  for (const signal of signals) {
    const createdAt = new Date(signal.createdAt);
    const meetsAgeCriteria = createdAt < cutoff;
    const meetsStatusCriteria = statusFilter ? signal.status === statusFilter : true;

    if (meetsAgeCriteria && meetsStatusCriteria && signal.status !== "ARCHIVED") {
      matched++;
      signal.status = "ARCHIVED";
      signal.updatedAt = now.toISOString();
      signal.archivedAt = now.toISOString();
      archivedCount++;
    }
  }

  // Persist changes
  await writeSignals(signals);

  console.log("[signals/archive] completed", {
    matched,
    archivedCount,
    cutoffIso,
    statusFilter,
  });

  return NextResponse.json({
    ok: true,
    matched,
    archivedCount,
    cutoffIso,
    statusFilter,
  });
}

// Additional logic for cursor-based pagination if needed.