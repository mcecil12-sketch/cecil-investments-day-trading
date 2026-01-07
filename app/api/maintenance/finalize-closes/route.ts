import { NextResponse } from "next/server";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import { finalizeTradeClose } from "@/lib/trades/finalizeClose";

export const dynamic = "force-dynamic";

function isAuthed(req: Request) {
  const tok = req.headers.get("x-cron-token") || "";
  return Boolean(process.env.CRON_TOKEN && tok && tok === process.env.CRON_TOKEN);
}

export async function POST(req: Request) {
  if (!isAuthed(req)) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const tickers = (url.searchParams.get("tickers") || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || "50"), 1), 500);

  const trades = await readTrades();
  const candidates = trades
    .filter((t: any) => String(t.status || "").toUpperCase() === "CLOSED" && (t.realizedPnL == null || t.realizedR == null))
    .filter((t: any) => (tickers.length ? tickers.includes(String(t.ticker || "").toUpperCase()) : true))
    .sort((a: any, b: any) => String(b.closedAt || "").localeCompare(String(a.closedAt || "")))
    .slice(0, limit);

  const updates: any[] = [];
  const results: any[] = [];

  for (const t of candidates) {
    const r = await finalizeTradeClose(t);
    results.push({ id: t.id, ticker: t.ticker, ...r });

    if (!r.ok) continue;

    if (r.action === "FINALIZED") {
      updates.push({
        ...t,
        closePrice: (r as any).closePrice,
        realizedPnL: (r as any).realizedPnL,
        realizedR: (r as any).realizedR,
        closeReason: (r as any).closeReason,
        finalizedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      continue;
    }

    if (r.action === "REOPENED") {
      updates.push({
        ...t,
        status: "OPEN",
        closedAt: null,
        closeReason: (r as any).reason,
        realizedPnL: null,
        realizedR: null,
        updatedAt: new Date().toISOString(),
      });
      continue;
    }

    if (r.action === "VOIDED") {
      updates.push({
        ...t,
        status: "DISABLED",
        autoEntryStatus: "AUTO_DISABLED",
        error: "voided_no_entry_fill",
        closeReason: (r as any).reason,
        realizedPnL: 0,
        realizedR: 0,
        updatedAt: new Date().toISOString(),
      });
      continue;
    }
  }

  if (updates.length) {
    const byId = new Map<string, any>(updates.map((u) => [String(u.id), u]));
    const merged = trades.map((t: any) => byId.get(String(t.id)) || t);
    await writeTrades(merged);
  }

  return NextResponse.json({
    ok: true,
    checked: candidates.length,
    updated: updates.length,
    results,
  });
}
