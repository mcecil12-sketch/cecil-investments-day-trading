import { NextResponse } from "next/server";
import { readTrades } from "@/lib/tradesStore";
import { requireAuth } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function hasCronToken(req: Request): boolean {
  const tok = String(req.headers.get("x-cron-token") || "").trim();
  return Boolean(process.env.CRON_TOKEN) && tok === process.env.CRON_TOKEN;
}

export async function GET(req: Request) {
  const cronOk = hasCronToken(req);
  const cookieAuth = await requireAuth(req);
  if (!cronOk && !cookieAuth.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const rawLimit = Number(url.searchParams.get("limit") || "20");
  const limit = Math.min(100, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 20));
  const sourceFilter = String(url.searchParams.get("source") || "").toLowerCase();

  const trades = await readTrades<any>();

  // Filter to AUTO-source trades (or all trades when source=all)
  const filtered = trades.filter((t: any) => {
    if (!t) return false;
    if (sourceFilter === "all") return true;
    const source = String(t.source || "").toLowerCase();
    return source === "auto" || source === "auto-entry";
  });

  // Sort newest first
  filtered.sort((a: any, b: any) => {
    const aTs = Date.parse(a.createdAt || a.updatedAt || "") || 0;
    const bTs = Date.parse(b.createdAt || b.updatedAt || "") || 0;
    return bTs - aTs;
  });

  const limited = filtered.slice(0, limit);

  const result = limited.map((t: any) => ({
    id: t.id,
    symbol: t.symbol ?? t.ticker ?? null,
    status: t.status ?? null,
    source: t.source ?? null,
    alpacaOrderId: t.alpacaOrderId ?? t.brokerOrderId ?? null,
    stopOrderId: t.stopOrderId ?? null,
    takeProfitOrderId: t.takeProfitOrderId ?? null,
    executeOutcome: t.executeOutcome ?? null,
    executeReason: t.executeReason ?? null,
    entryNotificationSentAt: t.entryNotificationSentAt ?? null,
    openNotificationSentAt: t.openNotificationSentAt ?? null,
    closeNotificationSentAt: t.closeNotificationSentAt ?? null,
    lastNotificationReason: t.lastNotificationReason ?? null,
    createdAt: t.createdAt ?? null,
    closedAt: t.closedAt ?? null,
    realizedPnL: t.realizedPnL ?? null,
    realizedR: t.realizedR ?? null,
  }));

  return NextResponse.json({
    ok: true,
    trades: result,
    meta: {
      total: filtered.length,
      limit,
      generated: new Date().toISOString(),
    },
  });
}
