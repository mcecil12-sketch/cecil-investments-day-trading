import { NextRequest, NextResponse } from "next/server";
import { alpacaRequest } from "@/lib/alpaca";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import { redis } from "@/lib/redis";
import { nowETDate } from "@/lib/performance/time";
import { selectCanonicalOpenTrades } from "@/lib/trades/canonicalOpenBySymbol";
import {
  buildBrokerSyncExecutedPatch,
  normalizeClosedTradeProtection,
} from "@/lib/trades/lifecycle";
import { sendNotification } from "@/lib/notifications/notify";
import { buildTradeClosedPayload } from "@/lib/notifications/tradeClose";

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
  const sinceHoursParam = asNum(url.searchParams.get("sinceHours"));
  const sinceHours = sinceHoursParam !== null ? Math.max(1, Math.min(336, sinceHoursParam)) : null;
  const sinceIso = sinceHours !== null ? isoHoursAgo(sinceHours) : null;

  const startedAt = new Date().toISOString();

  const trades = await readTrades();

  const candidates = trades.filter((t: any) => {
    const status = t?.status;
    // Include all non-terminal trades (not CLOSED and not ERROR)
    const isTerminal = status === "CLOSED" || status === "ERROR";
    if (isTerminal) return false;
    
    // Time filtering: only apply if sinceHours was explicitly provided
    if (sinceIso === null) return true; // No time filter when sinceHours not provided
    
    // Use updatedAt ?? createdAt, tolerate missing timestamps
    const timestamp = t?.updatedAt ?? t?.createdAt;
    if (!timestamp) return true; // Include trades with no timestamp
    return timestamp >= sinceIso;
  });

  const positionsResp = await alpacaRequest({ method: "GET", path: "/v2/positions" });
  const positions = positionsResp.text ? JSON.parse(positionsResp.text || "[]") : [];
  const ordersResp = await alpacaRequest({ method: "GET", path: "/v2/orders?status=open&limit=500" });
  const openOrders = ordersResp.text ? JSON.parse(ordersResp.text || "[]") : [];

  const posSet = new Set((positions ?? []).map((p: AlpacaPosition) => p.symbol));
  const openOrderById = new Map<string, AlpacaOrder>();
  for (const o of openOrders ?? []) openOrderById.set((o as AlpacaOrder).id, o as AlpacaOrder);

  let updated = 0;
  let filledToOpen = 0;
  let canceledOrRejected = 0;
  let missingAtBroker = 0;
  let closedGhosts = 0;

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
      // Preserve / repair execution attribution: if a prior execute-route run wrote
      // a SKIPPED_* outcome (e.g. ticker_cooldown) but the trade was subsequently
      // filled at broker, correct the attribution to EXECUTED.
      const execPatch = buildBrokerSyncExecutedPatch(t, nowIso);
      if (Object.keys(execPatch).length > 0) {
        Object.assign(t, execPatch);
      }
      filledToOpen++;
      changed = true;
    } else if (brokerStatus === "filled" && !brokerHasPosition && prevStatus !== "CLOSED") {
      // Order was filled at broker but position no longer exists — it was closed
      // (stop hit, TP filled, or EOD flatten) before this sync ran.
      // Finalize as CLOSED/RECONCILED rather than leaving in an open/pending state.
      t.status = "CLOSED";
      t.autoEntryStatus = "CLOSED";
      t.alpacaStatus = "filled";
      t.closeReason = t.closeReason ?? "broker_sync_position_closed";
      t.closedAt = t.closedAt ?? nowIso;
      t.updatedAt = nowIso;
      if (!t.entryFillPrice && filledAvg != null) t.entryFillPrice = filledAvg;
      if (!t.entryPrice && filledAvg != null) t.entryPrice = filledAvg;
      // Repair execution attribution if needed
      const execPatch2 = buildBrokerSyncExecutedPatch(t, nowIso);
      if (Object.keys(execPatch2).length > 0) Object.assign(t, execPatch2);
      // Normalize any stale protection status on this newly-closed trade
      const normPatch = normalizeClosedTradeProtection(t, nowIso);
      if (Object.keys(normPatch).length > 0) Object.assign(t, normPatch);
      filledToOpen++; // counts as a reconciled execution
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
      // Ghost detection: trade is alive but has no broker position and no order
      // Apply safety delay: only if trade is older than 15 minutes
      const timestamp = t?.updatedAt ?? t?.createdAt;
      if (timestamp) {
        const ageMs = Date.now() - new Date(timestamp).getTime();
        const fifteenMinutesMs = 15 * 60 * 1000;
        if (ageMs > fifteenMinutesMs) {
          t.status = "ERROR";
          t.autoEntryStatus = "AUTO_ERROR";
          t.error = "broker_missing";
          t.closeReason = "stale_no_broker_position_or_order";
          t.updatedAt = nowIso;
          closedGhosts++;
          changed = true;
        }
      }
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

  // ── Ghost-duplicate cleanup pass ─────────────────────────────────────────
  // After status updates, archive any ghost OPEN duplicates for the same ticker
  // so they don't cause false PROTECTION_MISSING in downstream checks.
  const nowIsoDedup = new Date().toISOString();
  const { ghosts: syncGhosts, diagnostics: syncDupDiag } = selectCanonicalOpenTrades(trades);
  let syncArchivedGhosts = 0;

  for (const ghost of syncGhosts) {
    // Only act on records that are still operationally open after the sync pass
    const status = String((ghost as any)?.status ?? "").toUpperCase();
    if (status === "ARCHIVED" || status === "CLOSED" || status === "ERROR") continue;

    const canonicalId = (ghost as any)._canonicalId;
    Object.assign(ghost, {
      status: "ARCHIVED",
      closedAt: nowIsoDedup,
      updatedAt: nowIsoDedup,
      closeReason: "superseded_by_canonical_open_trade",
      duplicateOfTradeId: canonicalId,
      alpacaStatus: null,
      brokerStatus: null,
      note: ((ghost as any)?.note || "") +
        ` [broker-sync archived: ghost duplicate superseded by ${canonicalId}]`,
    });
    syncArchivedGhosts++;
    updated++;
  }

  if (syncDupDiag.length > 0) {
    console.log("[sync-broker-state] archived ghost OPEN duplicates", {
      groups: syncDupDiag.map((d) => ({
        ticker: d.ticker,
        canonical: d.canonicalId,
        source: d.canonicalSource,
        ghosts: d.ghostCount,
        ghostIds: d.ghostIds,
      })),
      totalArchived: syncArchivedGhosts,
    });
  }
  // ── end ghost-duplicate cleanup ───────────────────────────────────────────

  // ── Closed-trade protection normalization pass ────────────────────────────
  // CLOSED / ERROR / ARCHIVED trades that still carry a stale risk-oriented
  // protectionStatus (e.g. REPAIR_FAILED) are misleading and can trigger false
  // protection incidents in funnel-health.  This pass clears them.
  let closedProtectionNormalized = 0;
  const nowIsoNorm = new Date().toISOString();
  for (let _ci = 0; _ci < trades.length; _ci++) {
    const _ct = trades[_ci] as any;
    if (!_ct) continue;
    const normPatch = normalizeClosedTradeProtection(_ct, nowIsoNorm);
    if (Object.keys(normPatch).length > 0) {
      trades[_ci] = { ..._ct, ...normPatch };
      closedProtectionNormalized++;
      updated++;
    }
  }
  if (closedProtectionNormalized > 0) {
    console.log("[sync-broker-state] normalized stale protectionStatus on closed trades", {
      count: closedProtectionNormalized,
    });
  }
  // ── end closed-trade protection normalization ─────────────────────────────

  await writeTrades(trades);

  // ── Close notification follow-up pass ────────────────────────────────────
  // After trades are written, send TRADE_CLOSED notifications for any trade that:
  //   - Was submitted (has entryNotificationSentAt)
  //   - Is now CLOSED/ERROR
  //   - Has NOT yet received a closeNotificationSentAt
  // This handles the "position closed before finalize-closes ran" scenario so
  // the user can see that the trade was closed, not just sitting open.
  // We do this AFTER writeTrades so that even if notification delivery fails,
  // the DB is in a consistent state.
  const closeNotifNow = new Date().toISOString();
  let closeNotificationsSent = 0;
  const closeNotifTradeUpdates: any[] = [];

  for (const t of trades) {
    if (!t) continue;
    const status = String((t as any)?.status || "").toUpperCase();
    const isClosed = status === "CLOSED" || status === "ERROR";
    if (!isClosed) continue;
    if (!(t as any).entryNotificationSentAt) continue;
    if ((t as any).closeNotificationSentAt) continue;

    try {
      const { title, message } = buildTradeClosedPayload({
        ticker: (t as any).ticker,
        closeReason: (t as any).closeReason ?? "broker_sync_closed",
        realizedR: (t as any).realizedR ?? null,
        realizedPnL: (t as any).realizedPnL ?? null,
        entryPrice: (t as any).entryPrice ?? null,
        closePrice: (t as any).closePrice ?? null,
      });

      const result = await sendNotification({
        type: "TRADE_CLOSED",
        tradeId: String((t as any).id || ""),
        ticker: String((t as any).ticker || ""),
        paper: true,
        title,
        message,
        dedupeKey: `notify:dedupe:v1:trade_closed:${(t as any).id}`,
        dedupeTtlSec: 86400,
      });

      if (result.sent || result.skippedReason === "deduped") {
        closeNotifTradeUpdates.push({ id: (t as any).id, closeNotificationSentAt: closeNotifNow, lastNotificationReason: "trade_closed" });
        closeNotificationsSent++;
      }
    } catch {
      // non-fatal — notifications are best-effort
    }
  }

  if (closeNotifTradeUpdates.length > 0) {
    const byId = new Map(closeNotifTradeUpdates.map((u: any) => [u.id, u]));
    const merged = trades.map((t: any) => {
      const upd = byId.get(String(t?.id || ""));
      return upd ? { ...t, ...upd } : t;
    });
    await writeTrades(merged);
  }
  // ── end close notification follow-up ─────────────────────────────────────

  const summary: any = {
    ok: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    broker: {
      positions: positions?.length ?? 0,
      openOrders: openOrders?.length ?? 0,
    },
    scanned: candidates.length,
    updated,
    filledToOpen,
    canceledOrRejected,
    missingAtBroker,
    closedGhosts,
    closedProtectionNormalized,
    closeNotificationsSent,
  };

  // Only include sinceHours and sinceIso when explicitly provided
  if (sinceHours !== null) {
    summary.sinceHours = sinceHours;
    summary.sinceIso = sinceIso;
  }

  await writeSyncMetrics(summary);

  return NextResponse.json(summary);
}
