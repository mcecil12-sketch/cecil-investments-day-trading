import { NextRequest, NextResponse } from "next/server";
import { readTrades, writeTrades } from "@/lib/tradesStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RepairBrokerBackfillResult = {
  ok: boolean;
  dryRun: boolean;
  limit: number;
  repaired: number;
  scannedBackfillRows: number;
  scannedTickers: number;
  archivedAutoConflict: number;
  archivedDuplicates: number;
  archivedErrorPrimary: number;
  repairedIds: string[];
  repairedTickers: string[];
  message: string;
  error?: string;
};

function appendRepairNote(current: string | undefined, suffix: string): string {
  const base = current || "";
  return base.includes(suffix) ? base : `${base}${suffix}`;
}

/**
 * POST /api/maintenance/repair-broker-backfill
 *
 * Cleans up stale/duplicate broker_backfill rows by:
 * 1. Finding all broker_backfill rows with ERROR status or duplicates
 * 2. Archiving them with proper closedAt, closeReason, and clearing alpacaStatus/brokerStatus
 *
 * Query params:
 * - dryRun=true (default) - preview changes without persisting
 * - limit=N - max rows to repair (default: 1000)
 */
export async function POST(req: NextRequest) {
  const token = req.headers.get("x-cron-token") || "";
  const hasSession = req.headers.get("cookie")?.includes("session=") ?? false;
  const hasToken = !!process.env.CRON_TOKEN && token === process.env.CRON_TOKEN;

  if (!hasSession && !hasToken) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { searchParams } = new URL(req.url);
    const dryRunFromBody = typeof (body as any)?.dryRun === "boolean" ? (body as any).dryRun : undefined;
    const dryRun = dryRunFromBody ?? searchParams.get("dryRun") !== "false";

    const rawLimit = Number((body as any)?.limit ?? searchParams.get("limit") ?? "1000");
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(5000, Math.floor(rawLimit))) : 1000;

    const trades = await readTrades();
    const nowIso = new Date().toISOString();

    // Build set of tickers with OPEN AUTO trades
    const autoOpenTickers = new Set<string>();
    for (const t of trades) {
      if (t?.status === "OPEN" && (t?.source === "AUTO" || t?.source === "AUTO-ENTRY") && t?.ticker) {
        autoOpenTickers.add(t.ticker.toUpperCase());
      }
    }

    // Group broker_backfill rows by ticker
    const backfillByTicker = new Map<string, any[]>();
    for (const t of trades) {
      if (t?.source === "broker_backfill" && t?.ticker) {
        const ticker = t.ticker.toUpperCase();
        if (!backfillByTicker.has(ticker)) {
          backfillByTicker.set(ticker, []);
        }
        backfillByTicker.get(ticker)!.push(t);
      }
    }

    const scannedBackfillRows = Array.from(backfillByTicker.values()).reduce((sum, rows) => sum + rows.length, 0);
    const scannedTickers = backfillByTicker.size;

    let repaired = 0;
    let archivedAutoConflict = 0;
    let archivedDuplicates = 0;
    let archivedErrorPrimary = 0;
    const repairedIds: string[] = [];
    const repairedTickers: string[] = [];

    // For each ticker, keep only the best broker_backfill row, archive the rest
    // Exception: if an AUTO trade exists for the ticker, archive ALL broker_backfill rows
    for (const [ticker, rows] of backfillByTicker.entries()) {
      if (rows.length === 0) continue;

      // If AUTO trade exists for this ticker, archive ALL broker_backfill rows
      if (autoOpenTickers.has(ticker)) {
        for (const row of rows) {
          if (row.status === "ARCHIVED" || row.status === "CLOSED") continue;
          if (repaired >= limit) break;

          if (!dryRun) {
            Object.assign(row, {
              status: "ARCHIVED",
              closedAt: nowIso,
              updatedAt: nowIso,
              closeReason: "duplicate_broker_backfill",
              alpacaStatus: null,
              brokerStatus: null,
              note: appendRepairNote(
                row?.note,
                " [Archived: duplicate broker_backfill when AUTO trade exists]"
              ),
            });
          }

          repaired += 1;
          archivedAutoConflict += 1;
          if (repairedIds.length < 20) {
            repairedIds.push(row.id);
          }
          if (!repairedTickers.includes(ticker) && repairedTickers.length < 20) {
            repairedTickers.push(ticker);
          }
        }
        continue; // All rows archived, move to next ticker
      }

      // No AUTO trade - sort to find best: prefer OPEN, then newest by updatedAt
      const sorted = rows.sort((a, b) => {
        if (a.status === "OPEN" && b.status !== "OPEN") return -1;
        if (b.status === "OPEN" && a.status !== "OPEN") return 1;
        return (b.updatedAt || "").localeCompare(a.updatedAt || "");
      });

      const toKeep = sorted[0];
      const toArchive = sorted.slice(1);

      // Archive duplicates
      for (const dup of toArchive) {
        if (dup.status === "ARCHIVED" || dup.status === "CLOSED") continue;
        if (repaired >= limit) break;

        if (!dryRun) {
          Object.assign(dup, {
            status: "ARCHIVED",
            closedAt: nowIso,
            updatedAt: nowIso,
            closeReason: "duplicate_broker_backfill",
            alpacaStatus: null,
            brokerStatus: null,
            note: appendRepairNote(dup?.note, " [Archived: duplicate broker_backfill cleaned up by repair]"),
          });
        }

        repaired += 1;
        archivedDuplicates += 1;
        if (repairedIds.length < 20) {
          repairedIds.push(dup.id);
        }
        if (!repairedTickers.includes(ticker) && repairedTickers.length < 20) {
          repairedTickers.push(ticker);
        }
      }

      // Also fix ERROR status on the kept one if it's in ERROR
      if (toKeep.status === "ERROR" && repaired < limit) {
        if (!dryRun) {
          Object.assign(toKeep, {
            status: "ARCHIVED",
            closedAt: nowIso,
            updatedAt: nowIso,
            closeReason: "stale_broker_backfill",
            alpacaStatus: null,
            brokerStatus: null,
            note: appendRepairNote(toKeep?.note, " [Archived: ERROR broker_backfill cleaned up by repair]"),
          });
        }

        repaired += 1;
        archivedErrorPrimary += 1;
        if (repairedIds.length < 20) {
          repairedIds.push(toKeep.id);
        }
        if (!repairedTickers.includes(ticker) && repairedTickers.length < 20) {
          repairedTickers.push(ticker);
        }
      }
    }

    if (!dryRun && repaired > 0) {
      await writeTrades(trades);
    }

    const response: RepairBrokerBackfillResult = {
      ok: true,
      dryRun,
      limit,
      repaired,
      scannedBackfillRows,
      scannedTickers,
      archivedAutoConflict,
      archivedDuplicates,
      archivedErrorPrimary,
      repairedIds,
      repairedTickers,
      message: dryRun
        ? `Would repair ${repaired} broker_backfill rows`
        : `Repaired ${repaired} broker_backfill rows`,
    };

    return NextResponse.json(response, {
      status: 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error: unknown) {
    console.error("[repair-broker-backfill] Error:", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
