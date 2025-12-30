import { NextResponse } from "next/server";
import { getAutoConfig } from "@/lib/autoEntry/config";
import { upsertTrade } from "@/lib/tradesStore";

export const dynamic = "force-dynamic";

function headerToken(req: Request) {
  return req.headers.get("x-auto-entry-token") || "";
}

function nowIso() {
  return new Date().toISOString();
}

async function ensureToken(req: Request) {
  const cfg = getAutoConfig();
  if (!cfg.token) return { ok: false as const, status: 500, error: "AUTO_ENTRY_TOKEN missing" };
  const got = headerToken(req);
  if (!got || got !== cfg.token) return { ok: false as const, status: 401, error: "unauthorized" };
  return { ok: true as const, cfg };
}

export async function POST(req: Request) {
  const auth = await ensureToken(req);
  if (!auth.ok) return NextResponse.json(auth, { status: auth.status });

  const body = await req.json().catch(() => ({}));
  const ticker = String(body?.ticker || "SPY").toUpperCase();
  const side = String(body?.side || "LONG").toUpperCase();
  const entryPrice = Number(body?.entryPrice ?? 470);
  const stopPrice = Number(body?.stopPrice ?? 468);
  const score = Number(body?.score ?? 7.6);

  const id = `AUTO_SEED_${ticker}_${Date.now()}`;

  const trade = {
    id,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ticker,
    side,
    entryPrice,
    stopPrice,
    targetPrice: Number(body?.targetPrice ?? (entryPrice + 4)),
    status: "AUTO_PENDING",
    source: "auto-entry",
    paper: true,
    ai: { score },
  };

  await upsertTrade(trade as any);

  return NextResponse.json({ ok: true, trade }, { status: 200 });
}
