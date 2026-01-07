import { NextResponse } from "next/server";
import { readTrades, writeTrades } from "@/lib/tradesStore";

export const dynamic = "force-dynamic";

function isCronAuthorized(req: Request) {
  const token = req.headers.get("x-cron-token") || "";
  return Boolean(process.env.CRON_TOKEN) && token === process.env.CRON_TOKEN;
}

export async function POST(req: Request) {
  try {
    if (!isCronAuthorized(req)) {
      return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const tradeId = String(body.tradeId || "");
    const ticker = String(body.ticker || "").toUpperCase();
    const reason = String(body.reason || "disabled_by_maintenance");

    if (!tradeId && !ticker) {
      return NextResponse.json({ ok: false, error: "missing_tradeId_or_ticker" }, { status: 400 });
    }

    const trades = await readTrades();
    const now = new Date().toISOString();
    let updated = 0;

    const next = trades.map((t: any) => {
      const match = tradeId ? t.id === tradeId : (ticker && (t.ticker || "").toUpperCase() === ticker);
      if (!match) return t;
      updated += 1;
      return {
        ...t,
        status: "ERROR",
        autoEntryStatus: "DISABLED",
        error: "disabled_by_maintenance",
        reason,
        updatedAt: now,
      };
    });

    if (updated === 0) {
      return NextResponse.json({ ok: false, error: "not_found", tradeId: tradeId || null, ticker: ticker || null }, { status: 404 });
    }

    await writeTrades(next);
    return NextResponse.json({ ok: true, updated, tradeId: tradeId || null, ticker: ticker || null, reason });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: "exception", detail: String(e?.message || e) }, { status: 500 });
  }
}
