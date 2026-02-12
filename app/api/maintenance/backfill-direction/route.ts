import { NextResponse } from "next/server";
import { readSignals, writeSignals } from "@/lib/jsonDb";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Compute signal direction with fallback logic:
 * 1. Prefer aiDirection if present and valid
 * 2. Use existing direction if valid
 * 3. Infer from entry/stop prices
 * 4. Default to LONG
 */
function computeDirectionFallback(signal: any): "LONG" | "SHORT" {
  // Prefer AI's chosen direction
  if (signal.aiDirection === "LONG" || signal.aiDirection === "SHORT") {
    return signal.aiDirection;
  }

  // Use existing heuristic direction if available
  if (signal.direction === "LONG" || signal.direction === "SHORT") {
    return signal.direction;
  }

  // Infer from entry/stop: stop < entry => LONG, stop > entry => SHORT
  const entry = Number(signal.entryPrice);
  const stop = Number(signal.stopPrice);
  if (Number.isFinite(entry) && Number.isFinite(stop)) {
    if (stop < entry) return "LONG";
    if (stop > entry) return "SHORT";
  }

  // Default to LONG
  return "LONG";
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

    const signals = await readSignals();
    const nowIso = new Date().toISOString();

    let updated = 0;
    const sample: any[] = [];

    // Filter signals where direction is null/undefined
    const needsBackfill = signals.filter(
      (s) => !s.direction || (s.direction !== "LONG" && s.direction !== "SHORT")
    );

    console.log("[backfill-direction] found signals needing backfill", {
      total: signals.length,
      needsBackfill: needsBackfill.length,
      dryRun,
    });

    for (const signal of needsBackfill) {
      const computedDirection = computeDirectionFallback(signal);
      
      if (!dryRun) {
        signal.direction = computedDirection;
        signal.updatedAt = nowIso;
      }

      updated += 1;

      // Collect sample for response (max 10)
      if (sample.length < 10) {
        sample.push({
          id: signal.id,
          ticker: signal.ticker,
          oldDirection: signal.direction || null,
          newDirection: computedDirection,
          aiDirection: signal.aiDirection || null,
          entryPrice: signal.entryPrice,
          stopPrice: signal.stopPrice,
        });
      }
    }

    if (!dryRun && updated > 0) {
      await writeSignals(signals);
      console.log("[backfill-direction] updated signals", { updated });
    }

    return NextResponse.json(
      {
        ok: true,
        dryRun,
        checked: signals.length,
        updated,
        needsBackfill: needsBackfill.length,
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
