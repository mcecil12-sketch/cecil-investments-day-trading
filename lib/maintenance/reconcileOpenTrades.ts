import { alpacaRequest } from "@/lib/alpaca";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import { fetchBrokerTruth } from "@/lib/broker/truth";
import { recordReconcile } from "@/lib/maintenance/reconcileTelemetry";

const POSITION_OPEN_OVERRIDES_CANCELED_v1 = true;

const up = (v: any) => String(v || "").toUpperCase();

async function safeJsonArray(text: string | undefined): Promise<any[]> {
  try {
    const parsed = JSON.parse(text || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function safeJsonObject(text: string | undefined): Promise<any | null> {
  try {
    const parsed = JSON.parse(text || "null");
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export type ReconcileOpenTradesOptions = {
  dryRun?: boolean;
  max?: number;
  closeReason?: string;
  syncToPositionOpen?: boolean;
  runSource?: string;
  runId?: string;
  deadlineMs?: number;
};

export type ReconcileOpenTradesResult = {
  ok: boolean;
  dryRun: boolean;
  checked: number;
  closed: number;
  synced: number;
  backfilled: number;
  backfilledTickers: string[];
  repairedOpenedAt: number;
  broker: {
    positionsCount: number;
    openOrdersCount: number;
    fetchedAt: string;
  };
  results: any[];
  error?: string;
  detail?: string;
};

export async function reconcileOpenTrades(
  options: ReconcileOpenTradesOptions = {}
): Promise<ReconcileOpenTradesResult> {
  const {
    dryRun = false,
    max = 500,
    closeReason = "reconciled_not_in_alpaca",
    syncToPositionOpen = true,
    runSource = "unknown",
    runId = "",
    deadlineMs = undefined,
  } = options;

  const startMs = Date.now();
  const checkDeadline = () => {
    if (deadlineMs && Date.now() - startMs > deadlineMs) {
      throw new Error(`reconcile timeout: exceeded ${deadlineMs}ms`);
    }
  };

  try {
    checkDeadline();

    const nowIso = new Date().toISOString();

    // Use broker-truth as authoritative source
    const brokerTruth = await fetchBrokerTruth();

    if (brokerTruth.error) {
      return {
        ok: false,
        dryRun,
        checked: 0,
        closed: 0,
        synced: 0,
        backfilled: 0,
        backfilledTickers: [],
        repairedOpenedAt: 0,
        broker: {
          positionsCount: 0,
          openOrdersCount: 0,
          fetchedAt: new Date().toISOString(),
        },
        results: [],
        error: "broker_truth_failed",
        detail: brokerTruth.error,
      };
    }

    checkDeadline();

    const posBySym = new Map<string, any>();
    for (const p of brokerTruth.positions) {
      const sym = up(p.symbol);
      if (sym) posBySym.set(sym, p);
    }

    const openOrderIdSet = new Set(
      brokerTruth.openOrders.map((o) => String(o.id || "")).filter(Boolean)
    );
    const openOrderSymSet = new Set(
      brokerTruth.openOrders.map((o) => up(o.symbol)).filter(Boolean)
    );

    const trades: any[] = await readTrades();
    const openTrades = trades
      .filter((t) => (t?.status || "").toUpperCase() === "OPEN")
      .slice(0, max);

    // Repair: Ensure all OPEN trades have openedAt set
    let repairedOpenedAt = 0;
    for (const t of openTrades) {
      if (!t.openedAt) {
        const ticker = up(t?.ticker);
        const brokerPos = ticker ? posBySym.get(ticker) : null;
        t.openedAt = brokerPos?.created_at || t.createdAt || nowIso;
        repairedOpenedAt += 1;
      }
    }

    if (repairedOpenedAt > 0 && !dryRun) {
      console.log(
        `[reconcile] repaired openedAt for ${repairedOpenedAt} OPEN trades (source=${runSource}, id=${runId})`
      );
    }

    let closed = 0;
    let synced = 0;

    const results: any[] = [];

    for (const t of openTrades) {
      checkDeadline();

      const ticker = up(t?.ticker);
      const existsPos = Boolean(ticker && posBySym.has(ticker));

      const alpacaOrderId = String(t?.alpacaOrderId || t?.brokerOrderId || "");
      const existsOrderId = Boolean(alpacaOrderId && openOrderIdSet.has(alpacaOrderId));
      const existsOrderSym = Boolean(ticker && openOrderSymSet.has(ticker));

      const stale = !existsPos && !existsOrderId && !existsOrderSym;

      if (stale) {
        if (!dryRun) {
          t.status = "CLOSED";
          t.closedAt = t.closedAt || nowIso;
          t.updatedAt = nowIso;
          t.closeReason = closeReason;
          t.autoEntryStatus = "CLOSED";
          t.alpacaStatus = t.alpacaStatus || "not_found_in_broker";
          t.brokerStatus = t.brokerStatus || "not_found_in_broker";
        }
        closed += 1;
        results.push({
          id: t?.id,
          ticker,
          stale: true,
          action: dryRun ? "would_close" : "closed",
          reason: "not_in_broker_positions_or_orders",
        });
        console.log(
          `[reconcile] closing stale trade (source=${runSource}, id=${runId})`,
          { tradeId: t?.id, ticker, alpacaOrderId }
        );
        continue;
      }

      if (syncToPositionOpen && existsPos) {
        let orderStatus: string | null = null;

        if (alpacaOrderId) {
          try {
            const r = await alpacaRequest({
              method: "GET",
              path: `/v2/orders/${encodeURIComponent(alpacaOrderId)}`,
            });
            const obj = await safeJsonObject(r.text);
            const s = obj?.status ? String(obj.status) : null;
            if (s) orderStatus = s;

            if (existsPos && orderStatus) {
              const os = String(orderStatus).toLowerCase();
              if (os === "canceled" || os === "expired" || os === "rejected") {
                orderStatus = "position_open";
              }
            }

            if (
              !dryRun &&
              obj &&
              (typeof obj.filled_qty === "string" || typeof obj.filled_qty === "number")
            ) {
              const fq = Number(obj.filled_qty);
              if (Number.isFinite(fq) && fq > 0) t.filledQty = fq;
            }
            if (
              !dryRun &&
              obj &&
              (typeof obj.filled_avg_price === "string" ||
                typeof obj.filled_avg_price === "number")
            ) {
              const ap = Number(obj.filled_avg_price);
              if (Number.isFinite(ap) && ap > 0) t.avgFillPrice = ap;
            }
          } catch (err) {
            console.warn(
              `[reconcile] order lookup failed (source=${runSource})`,
              { alpacaOrderId, error: String(err) }
            );
          }
        }

        if (!dryRun) {
          // Broker truth wins: enforce OPEN status when position exists
          t.status = "OPEN";
          t.autoEntryStatus = "OPEN";
          t.alpacaStatus = orderStatus || "position_open";
          t.brokerStatus = orderStatus || "position_open";
          t.updatedAt = nowIso;

          // Ensure openedAt is set (use existing or broker position time or now)
          if (!t.openedAt) {
            const brokerPos = posBySym.get(up(t?.ticker));
            t.openedAt = brokerPos?.created_at || nowIso;
          }

          // Clear closure/error fields that may have been artifact of previous status
          delete t.closedAt;
          delete t.finalizedAt;
          delete t.closeReason;
          delete t.error;
          delete t.realizedPnL;
          delete t?.realizedR;

          // Ensure filledQty/avgFillPrice are set from broker or estimate
          if (
            (t.filledQty == null || !Number.isFinite(Number(t.filledQty))) &&
            Number.isFinite(Number(t.qty))
          ) {
            t.filledQty = Number(t.qty);
          }

          if (
            (t.avgFillPrice == null || !Number.isFinite(Number(t.avgFillPrice))) &&
            Number.isFinite(Number(t.entryPrice))
          ) {
            t.avgFillPrice = Number(t.entryPrice);
          }
        }

        synced += 1;
        results.push({
          id: t?.id,
          ticker,
          stale: false,
          existsPos: true,
          existsOrderId,
          existsOrderSym,
          sync: dryRun ? "would_sync" : "synced",
          orderStatus: orderStatus || null,
        });
        continue;
      }

      results.push({
        id: t?.id,
        ticker,
        stale: false,
        existsPos,
        existsOrderId,
        existsOrderSym,
      });
    }

    checkDeadline();

    // Backfill: Create DB trades for broker positions not represented in DB
    let backfilled = 0;
    const backfilledTickers: string[] = [];
    const dbOpenTickerSet = new Set(openTrades.map((t) => up(t?.ticker)).filter(Boolean));

    for (const pos of brokerTruth.positions) {
      checkDeadline();

      const posTicker = up(pos.symbol);
      if (!posTicker || dbOpenTickerSet.has(posTicker)) {
        continue; // Already exists in DB
      }

      // Broker position not in DB, backfill it
      const newTrade: any = {
        id: crypto.randomUUID(),
        ticker: posTicker,
        side: (Number(pos.qty) > 0 ? "LONG" : "SHORT") as "LONG" | "SHORT",
        qty: Math.abs(Number(pos.qty || 0)),
        status: "OPEN",
        source: "broker_backfill",
        paper: true,
        note: "Backfilled from broker position during reconcile-open-trades",
        createdAt: pos.created_at || nowIso,
        openedAt: pos.created_at || nowIso,
        updatedAt: nowIso,
        entryPrice: Number(pos.avg_entry_price || 0),
        filledQty: Math.abs(Number(pos.qty || 0)),
        avgFillPrice: Number(pos.avg_entry_price || 0),
        autoEntryStatus: "OPEN",
        alpacaStatus: "position_open",
        brokerStatus: "position_open",
      };

      if (!dryRun) {
        trades.push(newTrade);
      }

      backfilled += 1;
      if (backfilledTickers.length < 10) {
        backfilledTickers.push(posTicker);
      }

      console.log(
        `[reconcile] backfilling broker position to DB (source=${runSource}, id=${runId})`,
        { ticker: posTicker, qty: newTrade.qty, side: newTrade.side, dryRun }
      );
    }

    checkDeadline();

    if (!dryRun && (closed > 0 || synced > 0 || backfilled > 0 || repairedOpenedAt > 0)) {
      await writeTrades(trades);
    }

    console.log(
      `[reconcile] completed (source=${runSource}, id=${runId})`,
      {
        brokerPositions: brokerTruth.positionsCount,
        dbOpenTrades: openTrades.length,
        closed,
        synced,
        backfilled,
        repairedOpenedAt,
      }
    );

    const result = {
      ok: true,
      dryRun,
      checked: openTrades.length,
      closed,
      synced,
      backfilled,
      backfilledTickers,
      repairedOpenedAt,
      broker: {
        positionsCount: brokerTruth.positionsCount,
        openOrdersCount: brokerTruth.openOrdersCount,
        fetchedAt: brokerTruth.fetchedAt,
      },
      results,
    };

    // Record telemetry (non-fatal if it fails)
    try {
      await recordReconcile({
        ts: new Date().toISOString(),
        source: runSource,
        runId: runId,
        checked: openTrades.length,
        closed,
        synced,
        ok: true,
      });
    } catch (e) {
      console.warn("[reconcile] telemetry recording failed:", e);
    }

    return result;
  } catch (err: any) {
    console.error(`[reconcile] failed (source=${runSource}, id=${runId})`, err);

    // Record failure telemetry (non-fatal if it fails)
    try {
      await recordReconcile({
        ts: new Date().toISOString(),
        source: runSource,
        runId: runId,
        checked: 0,
        closed: 0,
        synced: 0,
        ok: false,
      });
    } catch (e) {
      console.warn("[reconcile] telemetry recording failed:", e);
    }

    return {
      ok: false,
      dryRun,
      checked: 0,
      closed: 0,
      synced: 0,
      backfilled: 0,
      backfilledTickers: [],
      repairedOpenedAt: 0,
      broker: {
        positionsCount: 0,
        openOrdersCount: 0,
        fetchedAt: new Date().toISOString(),
      },
      results: [],
      error: "reconcile_failed",
      detail: err?.message || String(err),
    };
  }
}
