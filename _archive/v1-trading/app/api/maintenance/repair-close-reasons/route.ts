import { NextResponse } from "next/server";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import { ensureCloseReason } from "@/lib/trades/closeReasonNormalization";

export const dynamic = "force-dynamic";

function isAuthed(req: Request) {
  const token = req.headers.get("x-cron-token") || "";
  const hasSession = req.headers.get("cookie")?.includes("session=") ?? false;
  const hasToken = !!process.env.CRON_TOKEN && token === process.env.CRON_TOKEN;
  return hasSession || hasToken;
}

/**
 * POST /api/maintenance/repair-close-reasons
 * 
 * Backfills closeReason for CLOSED trades that have null/missing closeReason.
 * 
 * This is a one-time repair for historical data after adding closeReason normalization.
 * 
 * Query params:
 * - dryRun=1: Preview changes without writing
 * - limit=N: Max trades to process (default 500)
 * - olderThanDays=N: Only process trades closed more than N days ago
 */
export async function POST(req: Request) {
  if (!isAuthed(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const dryRun = url.searchParams.get("dryRun") === "1" || url.searchParams.get("dryRun") === "true";
  const limitRaw = Number(url.searchParams.get("limit") || "500");
  const limit = Math.min(5000, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 500));
  const olderThanDaysRaw = Number(url.searchParams.get("olderThanDays") || "0");
  const olderThanDays = Number.isFinite(olderThanDaysRaw) ? Math.max(0, olderThanDaysRaw) : 0;

  const now = new Date();
  const cutoffDate = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoffDate.toISOString();

  const trades = await readTrades();

  const candidates = trades
    .filter((t: any) => {
      const status = String(t?.status || "").toUpperCase();
      if (status !== "CLOSED") return false;

      const hasReason = Boolean(
        typeof t?.closeReason === "string" && t.closeReason.trim()
      );
      if (hasReason) return false;

      if (olderThanDays > 0) {
        const closedAt = t?.closedAt;
        if (!closedAt) return false;
        if (closedAt > cutoffIso) return false;
      }

      return true;
    })
    .slice(0, limit);

  const repaired: any[] = [];
  const byInferredReason: Record<string, number> = {};

  for (const t of candidates) {
    const normalized = ensureCloseReason(t);
    const inferredReason = normalized.closeReason || "unknown";

    repaired.push({
      id: t.id,
      ticker: t.ticker,
      closedAt: t.closedAt,
      wasReason: t.closeReason || null,
      nowReason: inferredReason,
    });

    byInferredReason[inferredReason] = (byInferredReason[inferredReason] || 0) + 1;
  }

  let written = 0;
  if (!dryRun && repaired.length > 0) {
    const byId = new Map<string, any>();
    for (const r of repaired) {
      const trade = trades.find((t: any) => String(t.id) === String(r.id));
      if (!trade) continue;
      byId.set(r.id, ensureCloseReason(trade));
    }

    const merged = trades.map((t: any) => {
      const updated = byId.get(String(t.id));
      return updated || t;
    });

    await writeTrades(merged);
    written = repaired.length;
  }

  console.log("[repair-close-reasons] completed", {
    dryRun,
    limit,
    olderThanDays,
    cutoffIso: olderThanDays > 0 ? cutoffIso : null,
    scanned: trades.length,
    candidates: candidates.length,
    repaired: repaired.length,
    written,
  });

  return NextResponse.json({
    ok: true,
    dryRun,
    limit,
    olderThanDays,
    cutoffIso: olderThanDays > 0 ? cutoffIso : null,
    scanned: trades.length,
    candidates: candidates.length,
    repaired: repaired.length,
    written,
    byInferredReason,
    sample: repaired.slice(0, 10),
  });
}
