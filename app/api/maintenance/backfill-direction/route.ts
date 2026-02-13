import { NextResponse } from "next/server";
import { readSignals, writeSignals } from "@/lib/jsonDb";
import { computeDirection } from "@/lib/scannerUtils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Compute signal direction from signalContext (VWAP/trend) when available.
 * 1. If signalContext exists with VWAP/trend, use computeDirection heuristic
 * 2. Otherwise return null (do NOT guess from entry/stop)
 */
function computeDirectionFromContext(signal: any): "LONG" | "SHORT" | null {
  // Try to use signalContext if available
  const ctx = signal.signalContext;
  if (ctx?.vwap != null && ctx?.trend) {
    const direction = computeDirection({
      price: Number(signal.entryPrice),
      vwap: ctx.vwap,
      trend: ctx.trend as "UP" | "DOWN" | "FLAT",
    });
    if (direction) return direction;
  }

  // No meaningful context → leave null
  return null;
}

export async function POST(req: Request) {
  // Gate by x-cron-token
  const token = req.headers.get("x-cron-token") || "";
  const hasToken = !!process.env.CRON_TOKEN && token === process.env.CRON_TOKEN;

  if (!hasToken) {
    return NextResponse.json(
      { ok: false, error: "unauthorized" },
      { status: 401 }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dryRun === true;
    const sinceHours = typeof body?.sinceHours === "number" ? body.sinceHours : null;
    const limit = typeof body?.limit === "number" ? body.limit : null;

    const allSignals = await readSignals();
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    // Filter by time window if sinceHours provided
    let candidateSignals = allSignals;
    if (sinceHours != null && sinceHours > 0) {
      const cutoffMs = nowMs - sinceHours * 3600 * 1000;
      candidateSignals = allSignals.filter((s) => {
        const createdMs = Date.parse(s.createdAt);
        return Number.isFinite(createdMs) && createdMs >= cutoffMs;
      });
    }

    // Sort newest-first for consistent ordering
    candidateSignals.sort((a, b) => {
      const ta = Date.parse(a.createdAt);
      const tb = Date.parse(b.createdAt);
      return tb - ta; // desc
    });

    // Apply limit after sorting
    if (limit != null && limit > 0 && candidateSignals.length > limit) {
      candidateSignals = candidateSignals.slice(0, limit);
    }

    // Filter signals where direction is null/undefined
    const needsBackfill = candidateSignals.filter(
      (s) => !s.direction || (s.direction !== "LONG" && s.direction !== "SHORT")
    );

    console.log("[backfill-direction] found signals needing backfill", {
      total: allSignals.length,
      candidateSignals: candidateSignals.length,
      needsBackfill: needsBackfill.length,
      sinceHours,
      limit,
      dryRun,
    });

    let updated = 0;
    const sample: any[] = [];

    for (const signal of needsBackfill) {
      const computedDirection = computeDirectionFromContext(signal);

      // Track whether we computed a direction
      const willUpdate = computedDirection !== null;

      if (!dryRun && willUpdate) {
        signal.direction = computedDirection;
        signal.updatedAt = nowIso;
        updated += 1;
      } else if (willUpdate) {
        // DryRun: just count
        updated += 1;
      }

      // Collect sample for response (max 10)
      if (sample.length < 10) {
        sample.push({
          id: signal.id,
          ticker: signal.ticker,
          oldDirection: signal.direction || null,
          newDirection: computedDirection,
          aiDirection: signal.aiDirection || null,
          hasContext: !!signal.signalContext,
          vwap: signal.signalContext?.vwap ?? null,
          trend: signal.signalContext?.trend ?? null,
        });
      }
    }

    if (!dryRun && updated > 0) {
      await writeSignals(allSignals);
      console.log("[backfill-direction] updated signals", { updated });
    }

    return NextResponse.json(
      {
        ok: true,
        dryRun,
        checked: candidateSignals.length,
        needsBackfill: needsBackfill.length,
        updated,
        sample,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("[backfill-direction] error", err);
    return NextResponse.json(
      {
        ok: false,
        error: "backfill_failed",
        detail: err?.message || String(err),
      },
      { status: 500 }
    );
  }
}
