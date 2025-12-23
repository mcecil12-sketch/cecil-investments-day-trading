import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import { alpacaRequest } from "@/lib/alpaca";

type ApplyStopBody = {
  tradeId: string;
  stopPrice: number;
};

function safeJsonParse(s: string) {
  try {
    return { ok: true as const, value: JSON.parse(s) };
  } catch {
    return { ok: false as const, value: null };
  }
}

function isAlpacaNotOpen(errText: string) {
  const p = safeJsonParse(errText);
  const msg = p.ok && p.value && typeof p.value.message === "string" ? p.value.message : "";
  const code = p.ok && p.value && typeof p.value.code === "number" ? p.value.code : null;
  return code === 42210000 && msg.toLowerCase().includes("not open");
}

export async function POST(req: Request) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: ApplyStopBody;
  try {
    body = (await req.json()) as ApplyStopBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const { tradeId, stopPrice } = body || ({} as any);
  if (!tradeId || typeof stopPrice !== "number" || Number.isNaN(stopPrice)) {
    return NextResponse.json({ ok: false, error: "Missing tradeId/stopPrice" }, { status: 400 });
  }

  const trades = await readTrades();
  const idx = trades.findIndex((t) => t.id === tradeId);
  if (idx === -1) {
    return NextResponse.json({ ok: false, error: "Trade not found", tradeId, totalTrades: trades.length }, { status: 404 });
  }

  const trade = trades[idx];

  const alpacaOrderId = (trade.alpacaOrderId || trade.brokerOrderId || null) as string | null;
  if (!alpacaOrderId) {
    return NextResponse.json(
      {
        ok: false,
        error: "Trade has no broker order id",
        tradeId,
        fields: { alpacaOrderId: trade.alpacaOrderId ?? null, brokerOrderId: trade.brokerOrderId ?? null },
      },
      { status: 400 }
    );
  }

  const nowIso = new Date().toISOString();

  try {
    let clearedStopId: string | null = trade.stopOrderId ?? null;

    if (trade.stopOrderId) {
      const del = await alpacaRequest({
        method: "DELETE",
        path: `/v2/orders/${trade.stopOrderId}`,
      });

      if (!del.ok) {
        const txt = del.text || "";
        if (isAlpacaNotOpen(txt) || del.status === 404) {
          clearedStopId = null;
        } else {
          return NextResponse.json(
            { ok: false, error: "Failed to cancel existing stop", detail: txt || null, stopOrderId: trade.stopOrderId },
            { status: 500 }
          );
        }
      } else {
        clearedStopId = null;
      }
    }

    const o = await alpacaRequest({
      method: "GET",
      path: `/v2/orders/${alpacaOrderId}`,
    });

    if (!o.ok) {
      // Parent order might be missing/expired/etc. We can still place a stop using the trade ticker.
    }

    const symbol = trade.ticker;

    const stop = await alpacaRequest({
      method: "POST",
      path: `/v2/orders`,
      body: {
        symbol,
        qty: String(trade.quantity ?? 1),
        side: trade.side === "LONG" ? "sell" : "buy",
        type: "stop",
        time_in_force: "day",
        stop_price: String(stopPrice),
      },
    });

    if (!stop.ok) {
      const detailStr = stop.text || null;

      const updatedTrade = {
        ...trade,
        stopPrice,
        stopOrderId: clearedStopId,
        lastStopAppliedAt: trade.lastStopAppliedAt ?? null,
        updatedAt: nowIso,
      };

      trades[idx] = updatedTrade;
      await writeTrades(trades);

      return NextResponse.json({ ok: false, error: "Failed to apply stop", detail: detailStr }, { status: 500 });
    }

    const stopJson = safeJsonParse(stop.text || "{}");
    const stopLegId =
      stopJson.ok && stopJson.value && typeof stopJson.value.id === "string" ? stopJson.value.id : null;

    const updatedTrade = {
      ...trade,
      stopPrice,
      stopOrderId: stopLegId,
      lastStopAppliedAt: nowIso,
      alpacaOrderId,
      brokerOrderId: trade.brokerOrderId ?? alpacaOrderId,
      alpacaStatus: trade.alpacaStatus ?? null,
      updatedAt: nowIso,
    };

    trades[idx] = updatedTrade;
    await writeTrades(trades);

    return NextResponse.json(
      { ok: true, trade: updatedTrade, orderId: alpacaOrderId, stopLegId, stopOrderId: stopLegId },
      { status: 200 }
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: "Failed to apply stop", detail: e?.message ? String(e.message) : null },
      { status: 500 }
    );
  }
}
