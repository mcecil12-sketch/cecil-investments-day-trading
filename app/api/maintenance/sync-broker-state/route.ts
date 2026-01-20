import { NextRequest, NextResponse } from "next/server";
import { alpacaRequest } from "@/lib/alpaca";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import { redis } from "@/lib/redis";
import { nowETDate } from "@/lib/performance/time";

type AlpacaPosition = { symbol: string };
type AlpacaOrder = {
  id: string;
  symbol: string;
  status: string;
  filled_avg_price?: string | null;
  filled_qty?: string | null;
  filled_at?: string | null;
  legs?: { id: string; status: string }[] | null;
};

function isoHoursAgo(hours: number) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function asNum(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isAuthed(req: NextRequest) {
  const tok = req.headers.get("x-cron-token") || "";
  return Boolean(process.env.CRON_TOKEN && tok && tok === process.env.CRON_TOKEN);
}

async function writeSyncMetrics(summary: any) {
  try {
    if (!redis) return;

    const dateET = nowETDate();
    const key = `brokerSync:summary:v1:${dateET}`;

    await redis.set(key, JSON.stringify(summary));
    await redis.set("brokerSync:lastSummaryKey:v1", key);
  } catch {
    return;
  }
}

export async function POST(req: NextRequest) {
  if (!isAuthed(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const sinceHours = asNum(url.searchParams.get("sinceHours")) ?? 72;
  const clampedHours = Math.max(1, Math.min(336, sinceHours));
  const sinceIso = isoHoursAgo(clampedHours);

  const startedAt = new Date().toISOString();

  const trades = await readTrades();

  const candidates = trades.filter((t: any) => {
    const createdAt = t?.createdAt ?? "";
    const status = t?.status;
    const aes = t?.autoEntryStatus;
    const alive =
      status === "OPEN" ||
      status === "AUTO_PENDING" ||
      aes === "OPEN" ||
      aes === "AUTO_PENDING";
    const recentEnough = createdAt && createdAt >= sinceIso;
    return alive && recentEnough;
  });

  const positions = (await alpacaRequest({ method: "GET", path: "/v2/positions" }))
    .text
    ? JSON.parse((await alpacaRequest({ method: "GET", path: "/v2/positions" })).text || "[]")
    : [];
  const openOrders = (await alpacaRequest({ method: "GET", path: "/v2/orders?status=open&limit=500" }))
    .text
    ? JSON.parse((await alpacaRequest({ method: "GET", path: "/v2/orders?status=open&limit=500" })).text || "[]")
    : [];

  const posSet = new Set((positions ?? []).map((p: AlpacaPosition) => p.symbol));
  const openOrderById = new Map<string, AlpacaOrder>();
  for (const o of openOrders ?? []) openOrderById.set((o as AlpacaOrder).id, o as AlpacaOrder);

  let updated = 0;
  let filledToOpen = 0;
  let canceledOrRejected = 0;
  let missingAtBroker = 0;

  const nowIso = new Date().toISOString();

  for (const t of candidates) {
    const orderId = t?.alpacaOrderId ?? t?.brokerOrderId ?? null;
    const ticker = t?.ticker;

    let brokerStatus: string | null = null;
    let filledAvg: number | null = null;

    if (orderId) {
      const open = openOrderById.get(orderId);
      if (open) {
        brokerStatus = open.status;
        filledAvg = asNum(open.filled_avg_price);
      } else {
        try {
          const resp = await alpacaRequest({ method: "GET", path: `/v2/orders/${orderId}` });
          const ord = resp.ok ? JSON.parse(resp.text) : null;
          brokerStatus = ord?.status ?? null;
          filledAvg = asNum(ord?.filled_avg_price);
        } catch {
          brokerStatus = null;
        }
      }
    }

    const brokerHasPosition = !!ticker && posSet.has(ticker);

    const prevStatus = t.status;
    const prevAES = t.autoEntryStatus;

    let changed = false;

    if ((brokerStatus === "filled" || brokerHasPosition) && prevStatus !== "OPEN") {
      t.status = "OPEN";
      t.autoEntryStatus = "OPEN";
      if (!t.entryFillPrice && filledAvg != null) t.entryFillPrice = filledAvg;
      if (!t.entryPrice && filledAvg != null) t.entryPrice = filledAvg;
      t.alpacaStatus = "filled";
      t.updatedAt = nowIso;
      filledToOpen++;
      changed = true;
    } else if (
      brokerStatus === "canceled" ||
      brokerStatus === "rejected" ||
      brokerStatus === "expired"
    ) {
      t.status = "ERROR";
      t.autoEntryStatus = "AUTO_ERROR";
      t.alpacaStatus = brokerStatus;
      t.error = `broker_${brokerStatus}`;
      t.updatedAt = nowIso;
      canceledOrRejected++;
      changed = true;
    } else if (!orderId && !brokerHasPosition) {
      missingAtBroker++;
    } else {
      if (brokerStatus && t.alpacaStatus !== brokerStatus) {
        t.alpacaStatus = brokerStatus;
        t.updatedAt = nowIso;
        changed = true;
      }
    }

    if (changed) updated++;
  }

  await writeTrades(trades);

  const summary = {
    ok: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    sinceHours: clampedHours,
    sinceIso,
    broker: {
      positions: positions?.length ?? 0,
      openOrders: openOrders?.length ?? 0,
    },
    scanned: candidates.length,
    updated,
    filledToOpen,
    canceledOrRejected,
    missingAtBroker,
  };

  await writeSyncMetrics(summary);

  return NextResponse.json(summary);
}
