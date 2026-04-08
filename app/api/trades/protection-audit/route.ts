/**
 * GET /api/trades/protection-audit
 * Audits open trades for missing or inadequate stop protection.
 * Flags trades without stops, or with stops that exceed risk thresholds.
 */
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { readTrades } from "@/lib/tradesStore";

const DEEP_LOSS_R = -1.5;

type AnyTrade = Record<string, unknown>;

function isOpenTrade(t: AnyTrade): boolean {
  const s = String(t?.status ?? "").toUpperCase();
  return s === "OPEN" || s === "AUTO_OPEN" || s === "MANUAL" || s === "ACTIVE";
}

function hasStop(t: AnyTrade): boolean {
  const stop = Number(t?.stopPrice ?? t?.stop_price ?? 0);
  return Number.isFinite(stop) && stop > 0;
}

function inferR(t: AnyTrade): number | null {
  const entry = Number(t?.entryPrice ?? t?.entry_price ?? 0);
  const stop = Number(t?.stopPrice ?? t?.stop_price ?? 0);
  const current = Number(t?.currentPrice ?? t?.lastPrice ?? t?.markPrice ?? 0);

  if (!Number.isFinite(entry) || entry <= 0) return null;
  if (!Number.isFinite(stop) || stop <= 0) return null;
  if (!Number.isFinite(current) || current <= 0) return null;

  const rPerShare = Math.abs(entry - stop);
  if (rPerShare === 0) return null;

  const side = String(t?.side ?? "").toUpperCase();
  const unrealizedPnlPerShare = side === "SELL" || side === "SHORT"
    ? entry - current
    : current - entry;

  return Math.round((unrealizedPnlPerShare / rPerShare) * 1000) / 1000;
}

export async function GET() {
  const all = await readTrades<AnyTrade>().catch(() => []);
  const open = (Array.isArray(all) ? all : []).filter(isOpenTrade);

  const noStop = open.filter((t) => !hasStop(t));
  const withStop = open.filter((t) => hasStop(t));

  const atDeepLoss = withStop.filter((t) => {
    const r = inferR(t);
    return r != null && r <= DEEP_LOSS_R;
  });

  const flags = [
    ...noStop.map((t) => ({
      id: t.id,
      ticker: t.ticker,
      side: t.side,
      status: t.status,
      issue: "missing_stop",
      rMultiple: null,
    })),
    ...atDeepLoss.map((t) => ({
      id: t.id,
      ticker: t.ticker,
      side: t.side,
      status: t.status,
      issue: "deep_loss",
      rMultiple: inferR(t),
    })),
  ];

  return NextResponse.json({
    ok: true,
    openTrades: open.length,
    protectedTrades: withStop.length,
    unprotectedTrades: noStop.length,
    deepLossCount: atDeepLoss.length,
    protectionRate: open.length > 0 ? Math.round((withStop.length / open.length) * 100) / 100 : null,
    flags,
  });
}
