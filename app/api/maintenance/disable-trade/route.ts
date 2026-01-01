import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { readTrades, writeTrades } from "@/lib/tradesStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { tradeId?: string; reason?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {}

  const tradeId = String(body.tradeId || "").trim();
  if (!tradeId) {
    return NextResponse.json({ ok: false, error: "missing_tradeId" }, { status: 400 });
  }

  const trades = await readTrades<any>();
  const idx = trades.findIndex((t) => String(t?.id || "") === tradeId);
  if (idx === -1) {
    return NextResponse.json({ ok: false, error: "trade_not_found" }, { status: 404 });
  }

  const now = new Date().toISOString();
  const reason = String(body.reason || "manual").trim() || "manual";

  trades[idx] = {
    ...trades[idx],
    status: "DISABLED",
    autoEntryStatus: "AUTO_DISABLED",
    error: `disabled:${reason}`,
    updatedAt: now,
  };

  await writeTrades(trades);

  return NextResponse.json({ ok: true, tradeId }, { status: 200 });
}
