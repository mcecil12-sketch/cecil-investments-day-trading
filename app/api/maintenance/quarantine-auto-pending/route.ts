import { NextResponse } from "next/server";
import { readTrades, writeTrades } from "@/lib/tradesStore";

export const dynamic = "force-dynamic";

function nowIso() {
  return new Date().toISOString();
}

type Body = {
  ids?: string[];
  dryRun?: boolean;
};

export async function POST(req: Request) {
  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {}

  const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
  const dryRun = Boolean(body.dryRun);

  if (!ids.length) {
    return NextResponse.json({ ok: false, error: "missing ids[]" }, { status: 400 });
  }

  const trades = await readTrades<any>();
  const idSet = new Set(ids);

  const updated: any[] = [];
  const skipped: any[] = [];

  for (let i = 0; i < trades.length; i += 1) {
    const t = trades[i];
    if (!t || !idSet.has(String(t.id || ""))) continue;

    const status = String(t.status || "");
    const source = String(t.source || "");
    const entryPrice = t?.entryPrice ?? null;
    const stopPrice = t?.stopPrice ?? null;

    const isAuto = source === "AUTO" || source === "auto-entry";
    const isAutoPending = status === "AUTO_PENDING";

    if (!isAuto || !isAutoPending) {
      skipped.push({ id: t.id, ticker: t.ticker, reason: "not_auto_pending_or_wrong_source", status, source });
      continue;
    }

    const invalid = entryPrice == null || stopPrice == null || Number(entryPrice) <= 0 || Number(stopPrice) <= 0;

    if (!invalid) {
      skipped.push({ id: t.id, ticker: t.ticker, reason: "already_valid_prices" });
      continue;
    }

    const next = {
      ...t,
      status: "ERROR",
      brokerStatus: t.brokerStatus,
      error: "auto_entry_invalid_missing_prices",
      autoEntryStatus: "AUTO_ERROR",
      errorAt: nowIso(),
      errorDetails: {
        entryPrice: entryPrice ?? null,
        stopPrice: stopPrice ?? null,
        takeProfitPrice: t?.takeProfitPrice ?? null,
      },
      updatedAt: nowIso(),
    };

    updated.push({ id: next.id, ticker: next.ticker });
    if (!dryRun) trades[i] = next;
  }

  if (!dryRun) {
    await writeTrades(trades);
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    requested: ids.length,
    updatedCount: updated.length,
    skippedCount: skipped.length,
    updated,
    skipped,
  });
}
