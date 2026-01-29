import { NextResponse } from "next/server";
import { readSignals, writeSignals } from "@/lib/jsonDb";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Check cron token authorization
 */
function checkCronAuth(req: Request): { ok: boolean; reason?: string } {
  const token = req.headers.get("x-cron-token") || "";
  if (!process.env.CRON_TOKEN || token !== process.env.CRON_TOKEN) {
    return { ok: false, reason: "unauthorized" };
  }
  return { ok: true };
}

/**
 * Parse and validate request body
 */
interface ArchiveRequest {
  olderThanHours?: number;
  limit?: number;
}

function parseRequest(body: any): {
  olderThanHours: number;
  limit: number;
} {
  const olderThanHours = Math.max(
    0,
    Number(body?.olderThanHours ?? 48)
  );
  const limit = Math.max(1, Math.min(10000, Number(body?.limit ?? 500)));
  return { olderThanHours, limit };
}

/**
 * POST /api/maintenance/archive-signals
 *
 * Archive old signals that are no longer needed.
 *
 * Request body:
 * {
 *   "olderThanHours": 48,  // default 48
 *   "limit": 500           // default 500, max 10000
 * }
 *
 * Response: { ok, archived, remainingPending }
 *
 * Guarantees:
 * - Always returns JSON
 * - No redirects
 * - Completes quickly (processes up to limit)
 * - Status ARCHIVED signals will not be scored again
 */
export async function POST(req: Request) {
  // Check authorization first
  const auth = checkCronAuth(req);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: "unauthorized", reason: auth.reason },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  const result = {
    ok: true,
    archived: 0,
    remainingPending: 0,
    error: undefined as string | undefined,
  };

  try {
    // Parse request body
    let body: any = {};
    try {
      const text = await req.text();
      if (text) {
        body = JSON.parse(text);
      }
    } catch (err) {
      // Invalid JSON: proceed with defaults
      console.warn("[archive-signals] invalid body JSON", err);
    }

    const { olderThanHours, limit } = parseRequest(body);

    // Read signals
    const signals = await readSignals();
    const now = new Date();
    const cutoffTime = new Date(now.getTime() - olderThanHours * 60 * 60 * 1000);

    // Find archivable signals: SCORED or ERROR, created before cutoff
    const archivableSignals = signals
      .filter((s) => {
        if (s.status !== "SCORED" && s.status !== "ERROR") {
          return false;
        }
        const createdAt = new Date(s.createdAt);
        return createdAt < cutoffTime;
      })
      .sort((a, b) => {
        // Archive oldest first
        return (
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );
      });

    // Archive up to limit
    let archivedCount = 0;
    for (let i = 0; i < Math.min(archivableSignals.length, limit); i++) {
      const signal = archivableSignals[i];
      signal.status = "ARCHIVED";
      signal.updatedAt = new Date().toISOString();
      archivedCount += 1;
    }

    // Count remaining PENDING signals
    const remainingPending = signals.filter(
      (s) => s.status === "PENDING"
    ).length;

    // Write updated signals
    await writeSignals(signals);

    result.archived = archivedCount;
    result.remainingPending = remainingPending;

    console.log("[archive-signals] complete", {
      olderThanHours,
      limit,
      archived: archivedCount,
      remainingPending,
    });

    return NextResponse.json(result, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    // Unexpected error: still return JSON
    console.error("[archive-signals] fatal error", err);
    result.ok = false;
    result.error = String(err);
    return NextResponse.json(result, {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
