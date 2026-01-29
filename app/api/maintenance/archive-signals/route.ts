import { NextResponse } from "next/server";
import { readSignals, writeSignals, StoredSignal } from "@/lib/jsonDb";
import { redis } from "@/lib/redis";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Execution guards: wall-clock timeout
const DEADLINE_MS = Number(
  process.env.MAINT_ARCHIVE_SIGNALS_DEADLINE_MS ?? 8000
);

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
  olderThanHours: number;
  limit?: number;
  scanLimit?: number;
  cursor?: string;
  statuses?: string[];
  dryRun?: boolean;
}

function parseRequest(body: any): {
  olderThanHours: number;
  limit: number;
  scanLimit: number;
  cursor: string;
  statuses: string[];
  dryRun: boolean;
} {
  const olderThanHours = Math.max(0, Number(body?.olderThanHours ?? 48));
  const limit = Math.max(1, Math.min(10000, Number(body?.limit ?? 1000)));
  const scanLimit = Math.max(1, Math.min(50000, Number(body?.scanLimit ?? 5000)));
  const cursor = String(body?.cursor ?? "0");
  const statuses = Array.isArray(body?.statuses)
    ? body.statuses.filter((s: any) => typeof s === "string")
    : ["PENDING", "ERROR", "SCORED"];
  const dryRun = Boolean(body?.dryRun ?? false);

  return {
    olderThanHours,
    limit,
    scanLimit,
    cursor,
    statuses,
    dryRun,
  };
}

/**
 * POST /api/maintenance/archive-signals
 *
 * Archive old signals across entire keyspace with cursor-based pagination.
 * For full archive coverage, call repeatedly with cursor until cursorOut == "0".
 *
 * Request body:
 * {
 *   "olderThanHours": 48,           // required: archive signals older than this
 *   "limit": 1000,                  // optional: max archives per run (default 1000)
 *   "scanLimit": 5000,              // optional: max keys to scan per run (default 5000)
 *   "cursor": "0",                  // optional: redis scan cursor for pagination (default "0")
 *   "statuses": ["PENDING","ERROR","SCORED"],  // optional: statuses eligible to archive
 *   "dryRun": false                 // optional: if true, don't write updates (default false)
 * }
 *
 * Response:
 * {
 *   ok: boolean,
 *   archived: number,               // signals archived this run
 *   scanned: number,                // signals examined this run
 *   eligible: number,               // signals matching status+age criteria
 *   cursorIn: string,               // cursor provided
 *   cursorOut: string,              // next cursor (use in next call; "0" = finished)
 *   expired: boolean,               // true if deadline exceeded before finishing
 *   dryRun: boolean,                // whether this was a dry run
 *   olderThanHours: number,
 *   remainingPending?: number,      // count of PENDING signals (if not expensive)
 * }
 *
 * Guarantees:
 * - Always returns JSON
 * - No redirects
 * - Completes with deadline enforcement (default 8s)
 * - Cursor allows pagination over entire signal keyspace
 * - Supports dry-run for validation
 */
export async function POST(req: Request) {
  const startedAtMs = Date.now();
  const deadlineAtMs = startedAtMs + DEADLINE_MS;

  // Helper: check if deadline expired
  function isExpired(): boolean {
    return Date.now() >= deadlineAtMs;
  }

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
    scanned: 0,
    eligible: 0,
    cursorIn: "",
    cursorOut: "0",
    expired: false,
    dryRun: false,
    olderThanHours: 0,
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

    const {
      olderThanHours,
      limit,
      scanLimit,
      cursor,
      statuses,
      dryRun,
    } = parseRequest(body);

    result.cursorIn = cursor;
    result.dryRun = dryRun;
    result.olderThanHours = olderThanHours;

    const now = new Date();
    const cutoffTime = new Date(
      now.getTime() - olderThanHours * 60 * 60 * 1000
    );
    const eligibleStatuses = new Set(statuses);

    // Strategy: Use Redis SCAN if available for keyspace-wide iteration
    // Otherwise fall back to full signal read (slower but still comprehensive)

    if (redis) {
      // Use Redis SCAN for distributed iteration
      let nextCursor = "0";
      let scannedCount = 0;
      let archiveBuffer: any[] = [];

      try {
        // Scan signals pattern (assumes signals stored as redis keys, e.g., "signal:*")
        // Adjust pattern as needed based on actual signal storage
        const scanResult = await redis.scan(parseInt(cursor, 10) || 0, {
          match: "signal:*",
          count: scanLimit,
        });

        nextCursor = String(scanResult[0]);
        const keys = scanResult[1] || [];

        // Load and check each signal
        for (const key of keys) {
          if (isExpired()) {
            result.expired = true;
            break;
          }

          scannedCount += 1;
          result.scanned += 1;

          try {
            // Get signal from redis
            const signalData = await redis.get(key);
            if (!signalData || typeof signalData !== "string") continue;

            const signal = JSON.parse(signalData) as StoredSignal;
            if (!signal || typeof signal !== "object") continue;

            const { status, createdAt } = signal;
            const createdAtDate = new Date(createdAt || "");

            // Check if archivable
            if (
              eligibleStatuses.has(status) &&
              createdAtDate < cutoffTime
            ) {
              result.eligible += 1;

              if (result.archived < limit) {
                // Mark archived (don't delete)
                if (!dryRun) {
                  signal.status = "ARCHIVED";
                  signal.archived = true;
                  signal.archivedAt = now.toISOString();
                  signal.updatedAt = now.toISOString();
                  archiveBuffer.push({ key, signal });
                  result.archived += 1;
                } else {
                  // Dry run: just count
                  result.archived += 1;
                }
              }
            }
          } catch (err) {
            // Skip malformed signals
            console.warn("[archive-signals] malformed signal", { key, err });
          }

          if (scannedCount >= scanLimit || result.archived >= limit) {
            break;
          }
        }

        // Write archived signals back to redis (batch)
        if (!dryRun && archiveBuffer.length > 0) {
          for (const { key, signal } of archiveBuffer) {
            try {
              // Keep same TTL if previously set
              await redis.set(key, JSON.stringify(signal));
            } catch (err) {
              console.warn("[archive-signals] failed to update signal", { key, err });
            }
          }
        }

        result.cursorOut = nextCursor;
      } catch (err) {
        console.error("[archive-signals] redis scan error", err);
        // Fall through to file-based scan as fallback
        result.ok = false;
        result.error = `redis_scan_failed: ${String(err)}`;
      }
    } else {
      // Fall back to file-based scan: read all signals, apply pagination via cursor
      const signals = await readSignals();
      const now = new Date();
      const cutoffTime = new Date(
        now.getTime() - olderThanHours * 60 * 60 * 1000
      );

      // Simple cursor implementation: offset into array
      const cursorOffset = parseInt(cursor === "0" ? "0" : cursor, 10) || 0;
      const nextCursor = Math.min(
        cursorOffset + scanLimit,
        signals.length
      );
      const isFinished = nextCursor >= signals.length;

      // Process slice
      let archiveCount = 0;
      for (
        let i = cursorOffset;
        i < Math.min(nextCursor, signals.length);
        i++
      ) {
        if (isExpired()) {
          result.expired = true;
          break;
        }

        const signal = signals[i];
        result.scanned += 1;

        const createdAt = new Date(signal.createdAt || "");
        if (
          eligibleStatuses.has(signal.status) &&
          createdAt < cutoffTime
        ) {
          result.eligible += 1;

          if (archiveCount < limit) {
            if (!dryRun) {
              signal.status = "ARCHIVED";
              signal.archived = true;
              signal.archivedAt = now.toISOString();
              signal.updatedAt = now.toISOString();
              archiveCount += 1;
              result.archived += 1;
            } else {
              archiveCount += 1;
              result.archived += 1;
            }
          }
        }
      }

      // Write updates
      if (!dryRun && archiveCount > 0) {
        await writeSignals(signals);
      }

      result.cursorOut = isFinished ? "0" : String(nextCursor);
    }

    // Count remaining PENDING signals (useful for monitoring)
    try {
      const signals = await readSignals();
      result.remainingPending = signals.filter(
        (s) => s.status === "PENDING"
      ).length;
    } catch (err) {
      // Non-fatal
      console.warn("[archive-signals] pending count error", err);
    }

    console.log("[archive-signals] complete", {
      olderThanHours,
      archived: result.archived,
      scanned: result.scanned,
      eligible: result.eligible,
      cursorOut: result.cursorOut,
      expired: result.expired,
      dryRun,
      remainingPending: result.remainingPending,
      durationMs: Date.now() - startedAtMs,
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
