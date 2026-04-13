export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { readTrades, writeTrades } from "@/lib/tradesStore";

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
  try {
    const { searchParams } = new URL(req.url);
    const dryRun = searchParams.get("dryRun") !== "false";
    const limit = parseInt(searchParams.get("limit") || "1000", 10);

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

    let repaired = 0;
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
              note: (row?.note || "") + " [Archived: duplicate broker_backfill when AUTO trade exists]",
            });
          }

          repaired += 1;
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
            note: (dup?.note || "") + " [Archived: duplicate broker_backfill cleaned up by repair]",
          });
        }

        repaired += 1;
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
            note: (toKeep?.note || "") + " [Archived: ERROR broker_backfill cleaned up by repair]",
          });
        }

        repaired += 1;
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

    return NextResponse.json({
      ok: true,
      dryRun,
      repaired,
      repairedIds,
      repairedTickers,
      message: dryRun
        ? `Would repair ${repaired} broker_backfill rows`
        : `Repaired ${repaired} broker_backfill rows`,
    });
  } catch (error: any) {
    console.error("[repair-broker-backfill] Error:", error);
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 }
    );
  }
}
