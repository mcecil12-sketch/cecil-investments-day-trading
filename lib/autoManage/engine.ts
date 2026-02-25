import { getAutoManageConfig } from "@/lib/autoManage/config";
import { getRuleForGrade, shouldMoveToBreakEven, shouldEnableTrailing } from "@/lib/autoManage/gradeRules";
import { recordAutoManage } from "@/lib/autoManage/telemetry";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import { getLatestQuote, alpacaRequest, getPositions, createOrder } from "@/lib/alpaca";
import { syncStopForTrade, rescueStop } from "@/lib/autoManage/stopSync";
import { reconcileOpenTrades } from "@/lib/maintenance/reconcileOpenTrades";
import { sendNotification } from "@/lib/notifications/notify";
import { selectCanonicalOpenTrade } from "@/lib/trades/canonical";
import { decideCutLossAction } from "@/lib/autoManage/cutLoss";

export type AutoManageResult = {
  ok: true;
  skipped?: boolean;
  reason?: string;
  checked: number;
  updated: number;
  flattened: number;
  enabled: boolean;
  now: string;
  market?: any;
  notes?: string[];
  forced?: boolean;
  cfg: ReturnType<typeof getAutoManageConfig>;
  reconcile?: {
    ok: boolean;
    checked: number;
    closed: number;
    synced: number;
    note: string;
  };
};

const num = (v: any) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const roundTo = (n: number, d: number) => {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
};

const r2 = (n: number) => roundTo(n, 2);
const r3 = (n: number) => roundTo(n, 3);

async function getClockSafe() {
  const r = await alpacaRequest({ method: "GET", path: "/v2/clock" });
  if (!r.ok) return null;
  try {
    return JSON.parse(r.text || "null");
  } catch {
    return null;
  }
}

function isMarketClosed(clock: any) {
  return clock && typeof clock.is_open === "boolean" ? !clock.is_open : false;
}

function midFromQuote(q: any): number | null {
  const last = num(q?.lastPrice ?? q?.lp ?? q?.last ?? q?.p ?? q?.price);
  const ask = num(q?.askPrice ?? q?.ap);
  const bid = num(q?.bidPrice ?? q?.bp);
  if (last != null) return last;
  if (ask != null && bid != null) return (ask + bid) / 2;
  if (ask != null) return ask;
  if (bid != null) return bid;
  return null;
}

function riskPerShare(entry: number, stop: number) {
  const r = Math.abs(entry - stop);
  return r > 0 ? r : null;
}

function normalizeQty(trade: any) {
  const q = Number(trade?.quantity ?? trade?.qty ?? trade?.size ?? trade?.positionSize ?? trade?.shares ?? 0);
  return Number.isFinite(q) && q > 0 ? q : 0;
}

function appendRuleNote(trade: any, note: string) {
  const existing = typeof trade?.note === "string" ? trade.note.trim() : "";
  if (!existing) return note;
  if (existing.includes(note)) return existing;
  return `${existing} | ${note}`;
}

async function submitMarketCloseForTrade(trade: any, ticker: string): Promise<
  | { ok: true; qty: number; orderId: string; status?: string }
  | { ok: false; error: string; detail?: string }
> {
  const side = String(trade?.side || "LONG").toUpperCase();
  const closeSide = side === "SHORT" ? "buy" : "sell";

  let qty = normalizeQty(trade);
  if (!qty) {
    try {
      const posRaw = await getPositions(ticker);
      const pos = Array.isArray(posRaw)
        ? posRaw.find((p: any) => String(p?.symbol || "").toUpperCase() === ticker)
        : posRaw;
      qty = Math.abs(Number((pos as any)?.qty ?? 0));
    } catch (err: any) {
      return { ok: false, error: "close_qty_lookup_failed", detail: String(err?.message || err) };
    }
  }

  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, error: "close_qty_invalid" };
  }

  try {
    const order: any = await createOrder({
      symbol: ticker,
      qty,
      side: closeSide,
      type: "market",
      time_in_force: "day",
      extended_hours: false,
    });

    const orderId = String(order?.id || "");
    if (!orderId) {
      return { ok: false, error: "close_order_missing_id" };
    }

    return {
      ok: true,
      qty,
      orderId,
      status: order?.status ? String(order.status) : undefined,
    };
  } catch (err: any) {
    return { ok: false, error: "close_order_failed", detail: String(err?.message || err) };
  }
}

/**
 * Stop Rescue Failsafe: ensure there's always an active protective stop when trade is OPEN and broker position exists.
 * - Check if stopOrderId exists and is active
 * - Check if broker position exists
 * - If both missing or stop not active, create new standalone GTC stop
 * - Persist stopOrderId only after Alpaca confirms acceptance
 * - Non-fatal: record telemetry and continue if rescue fails
 */
async function ensureStopRescued(trade: any, now: string, ticker: string): Promise<{ rescueAttempted: boolean; rescueOk?: boolean; rescueNote?: string }> {
  const stopOrderId = trade.stopOrderId;
  
  // Quick check: if stopOrderId exists, we assume it's active (detailed check in sync)
  if (stopOrderId) {
    return { rescueAttempted: false };
  }

  // No stop order ID - check if broker position exists
  try {
    const positions = await getPositions(ticker);
    const brokerPos = Array.isArray(positions)
      ? positions.find((p: any) => p?.symbol?.toUpperCase() === ticker)
      : null;

    const brokerQty = Number((brokerPos as any)?.qty ?? 0);
    if (brokerQty <= 0) {
      // No position, no rescue needed
      return { rescueAttempted: false };
    }

    // Broker position exists but no stop - attempt rescue
    const rescueRes = await rescueStop(trade);
    if (rescueRes.ok) {
      return {
        rescueAttempted: true,
        rescueOk: true,
        rescueNote: `stop_rescued: ${rescueRes.stopOrderId}`,
      };
    } else {
      return {
        rescueAttempted: true,
        rescueOk: false,
        rescueNote: `stop_rescue_failed: ${rescueRes.error}${rescueRes.detail ? ": " + rescueRes.detail : ""}`,
      };
    }
  } catch (err: any) {
    return {
      rescueAttempted: true,
      rescueOk: false,
      rescueNote: `stop_rescue_error: ${String(err?.message || err)}`,
    };
  }
}

export async function runAutoManage(opts: { source?: string; runId?: string; force?: boolean }): Promise<AutoManageResult> {
  const cfg = getAutoManageConfig();
  const now = new Date().toISOString();
  const notes: string[] = [];
  const force = !!opts.force;

  // === RECONCILE at START ===
  let reconcileNote = "";
  let reconcileResult: any = { ok: false, checked: 0, closed: 0, synced: 0 };
  try {
    const reconcileRunId = `${opts.runId || "auto-manage"}-reconcile`;
    const r = await reconcileOpenTrades({
      dryRun: false,
      runSource: "auto-manage",
      runId: reconcileRunId,
      deadlineMs: 3000,
    });
    reconcileResult = r;
    if (r.ok) {
      reconcileNote = `reconcile_ok closed=${r.closed ?? 0} checked=${r.checked ?? 0}`;
    } else {
      reconcileNote = `reconcile_failed ${r.error || "unknown"}`;
    }
  } catch (e: any) {
    reconcileNote = `reconcile_error ${String(e?.message || e)}`;
  }
  // Non-fatal: we continue even if reconcile failed
  console.log(`[autoManage] ${reconcileNote}`);
  if (reconcileNote) notes.push(`${reconcileNote}`);

  if (!cfg.enabled) {
    await recordAutoManage({ ts: now, outcome: "SKIP", reason: "disabled", source: opts.source, runId: opts.runId });
    return { ok: true, skipped: true, reason: "disabled", checked: 0, updated: 0, flattened: 0, enabled: false, now, cfg, reconcile: reconcileResult };
  }

  const clock = await getClockSafe();
  const marketClosed = isMarketClosed(clock);

  const all = await readTrades();
  const next = [...all];

  const openRaw = (all || []).filter((t: any) => String(t.status || "").toUpperCase() === "OPEN");

  const byTicker = new Map<string, any[]>();
  for (const t of openRaw) {
    const ticker = String(t?.ticker || "").toUpperCase();
    if (!ticker) continue;
    const arr = byTicker.get(ticker) || [];
    arr.push(t);
    byTicker.set(ticker, arr);
  }

  const open: any[] = [];
  let duplicateArchived = 0;

  for (const [ticker, group] of byTicker.entries()) {
    if (!group.length) continue;

    const { canonical, duplicates } = selectCanonicalOpenTrade(group);
    open.push(canonical);

    if (duplicates.length <= 0) continue;

    for (const dup of duplicates) {
      const dupId = String(dup?.id || "");
      if (!dupId) continue;
      const dupIdx = next.findIndex((x: any) => String(x?.id || "") === dupId);
      if (dupIdx < 0) continue;

      next[dupIdx] = {
        ...next[dupIdx],
        status: "ERROR",
        autoEntryStatus: "ARCHIVED_DUPLICATE_OPEN",
        error: "duplicate_open_trade_for_ticker",
        closeReason: "duplicate_open_archived",
        closedAt: next[dupIdx].closedAt || now,
        archivedAt: now,
        updatedAt: now,
      };
      duplicateArchived += 1;
      notes.push(`duplicate_archived:${ticker}:${dupId}`);
    }
  }

  if (!open.length) {
    if (duplicateArchived > 0) {
      await writeTrades(next);
    }
    await recordAutoManage({ ts: now, outcome: "SKIP", reason: "no_open_trades", source: opts.source, runId: opts.runId });
    return { ok: true, skipped: true, reason: "no_open_trades", checked: 0, updated: 0, flattened: 0, enabled: true, now, market: clock, cfg, reconcile: reconcileResult };
  }

  if (marketClosed && !cfg.eodFlatten && !force) {
    await recordAutoManage({ ts: now, outcome: "SKIP", reason: "market_closed", source: opts.source, runId: opts.runId });
    return { ok: true, skipped: true, reason: "market_closed", checked: 0, updated: 0, flattened: 0, enabled: true, now, market: clock, cfg, reconcile: reconcileResult };
  }

  let checked = 0;
  let updated = 0;
  let flattened = 0;
  let rescueAttempted = 0;
  let rescueOk = 0;
  let rescueFailed = 0;
  let hadFailures = false;
  const max = Math.min(cfg.maxPerRun, open.length);
  updated += duplicateArchived;

  for (let i = 0; i < max; i++) {
    const t: any = open[i];
    checked++;

    const id = String(t.id || "");
    const ticker = String(t.ticker || "").toUpperCase();
    const side = String(t.side || "LONG").toUpperCase();
    const qty = Number(t.quantity ?? t.qty ?? 0);

    const entry = num(t.entryPrice);
    const stop = num(t.stopPrice);

    if (!id || !ticker || !entry || !stop || !Number.isFinite(qty) || qty <= 0) {
      notes.push(`skip_invalid:${id || ticker}`);
      continue;
    }

    if (cfg.eodFlatten && marketClosed) {
      const idx = next.findIndex((x: any) => x.id === id);
      if (idx >= 0) {
        next[idx] = { ...next[idx], autoManage: { ...(next[idx].autoManage || {}), eodFlattenedAt: now } };
        updated++;
        flattened++;
      }
      continue;
    }

    let px: number | null = null;
    try {
      const q: any = await getLatestQuote(ticker);
      px = midFromQuote(q);
    } catch {
      px = null;
    }
    if (px == null) {
      notes.push(`no_price:${ticker}`);
      continue;
    }

    const rps = riskPerShare(entry, stop);
    if (!rps) {
      notes.push(`no_risk:${ticker}`);
      continue;
    }

    const pnlPerShare = side === "SHORT" ? (entry - px) : (px - entry);
    const unrealizedPnL = r2(pnlPerShare * qty);
    const unrealizedR = r3(pnlPerShare / rps);

    const cutLossAction = decideCutLossAction({
      enabled: cfg.cutLossEnabled,
      thresholdR: cfg.cutLossR,
      trade: {
        id,
        ticker,
        status: "OPEN",
        unrealizedR,
      },
    });

    if (cutLossAction) {
      const closeRes = await submitMarketCloseForTrade(t, ticker);
      const idx = next.findIndex((x: any) => x.id === id);

      if (!closeRes.ok) {
        notes.push(`cut_loss_fail:${ticker}:${closeRes.error}${closeRes.detail ? ":" + closeRes.detail : ""}`);
        hadFailures = true;
        if (idx >= 0) {
          next[idx] = {
            ...next[idx],
            autoManage: {
              ...(next[idx].autoManage || {}),
              lastRunAt: now,
              lastRule: "CUT_LOSS_R",
              lastCutLossStatus: "FAIL",
              lastCutLossError: `${closeRes.error}${closeRes.detail ? ":" + closeRes.detail : ""}`,
            },
            updatedAt: now,
          };
          updated++;
        }
        continue;
      }

      if (idx >= 0) {
        const current = next[idx];
        next[idx] = {
          ...current,
          status: "CLOSED",
          autoEntryStatus: "CLOSED",
          closedAt: now,
          updatedAt: now,
          closeReason: cutLossAction.reason,
          note: appendRuleNote(current, `rule:${cutLossAction.rule}`),
          unrealizedPnL,
          unrealizedR,
          lastPrice: r2(px),
          closeOrderId: closeRes.orderId,
          closeOrderStatus: closeRes.status,
          autoManage: {
            ...(current.autoManage || {}),
            lastRunAt: now,
            lastRule: "CUT_LOSS_R",
            lastCutLossAt: now,
            lastCutLossStatus: "OK",
            cutLossR: cfg.cutLossR,
          },
          error: undefined,
        };
      }

      notes.push(`cut_loss:${ticker}:r=${cutLossAction.r.toFixed(3)}:qty=${closeRes.qty}`);

      try {
        await sendNotification({
          type: "AUTO_CUT_LOSS",
          tradeId: id,
          ticker,
          paper: t?.paper !== false,
          title: `Auto cut-loss ${ticker}`,
          message: `Closed ${ticker} at ${cutLossAction.r.toFixed(3)}R qty ${closeRes.qty}`,
          dedupeKey: `AUTO_CUT_LOSS:${id}`,
          dedupeTtlSec: 3600,
          meta: {
            ticker,
            r: cutLossAction.r,
            qty: closeRes.qty,
            closeReason: cutLossAction.reason,
            rule: cutLossAction.rule,
          },
        });
      } catch (notifyErr: any) {
        notes.push(`cut_loss_notify_fail:${ticker}:${String(notifyErr?.message || notifyErr)}`);
      }

      flattened++;
      updated++;
      continue;
    }

    // === GRADE-BASED STOP MANAGEMENT ===
    let nextStop = stop;
    const tradeGrade = (t.grade ?? t.ai?.grade ?? t.signalGrade ?? "C") as string;
    const gradeRule = getRuleForGrade(tradeGrade);
    
    // Check if already at break-even or better
    const alreadyAtBreakEven = side === "SHORT" 
      ? (stop <= entry + 0.001) // SHORT: stop at or below entry
      : (stop >= entry - 0.001); // LONG: stop at or above entry
    
    // Move to break-even based on grade rule
    if (shouldMoveToBreakEven(unrealizedR, tradeGrade, alreadyAtBreakEven)) {
      nextStop = entry; // Move stop to entry (break-even)
    }
    
    // Lock in 1R profit at 2R (applicable to all grades)
    if (unrealizedR >= 2.0 && !alreadyAtBreakEven) {
      const lock1R = side === "SHORT" ? (entry - rps) : (entry + rps);
      nextStop = side === "SHORT" ? Math.min(nextStop, lock1R) : Math.max(nextStop, lock1R);
    }
    
    // Apply trailing stop if grade rule allows and currentR qualifies
    if (shouldEnableTrailing(unrealizedR, tradeGrade) && cfg.trailEnabled) {
      const trailStop = side === "SHORT" ? px * (1 + cfg.trailPct) : px * (1 - cfg.trailPct);
      nextStop = side === "SHORT" ? Math.min(nextStop, trailStop) : Math.max(nextStop, trailStop);
    }

    const idx = next.findIndex((x: any) => x.id === id);
    if (idx >= 0) {
      // STOP RESCUE FAILSAFE: ensure there's always an active protective stop
      let rescueAttemptedLocal = false;
      let rescueOkLocal = false;
      let rescueNote: string = "";
      try {
        const rescueResult = await ensureStopRescued(next[idx], now, ticker);
        rescueAttemptedLocal = rescueResult.rescueAttempted;
        rescueOkLocal = rescueResult.rescueOk ?? false;
        rescueNote = rescueResult.rescueNote || "";

        if (rescueAttemptedLocal) {
          rescueAttempted++;
          if (rescueOkLocal) {
            rescueOk++;
            // Stop was rescued - update trade with new stopOrderId
            next[idx] = {
              ...next[idx],
              stopOrderId: rescueNote.split(": ")[1], // Extract stopOrderId from note
              autoManage: {
                ...(next[idx].autoManage || {}),
                lastStopRescueAt: now,
                lastStopRescueStatus: "OK",
              },
              updatedAt: now,
            };
            notes.push(`stop_rescue_ok:${ticker}:${rescueNote}`);
            updated++;
          } else {
            rescueFailed++;
            // Rescue attempt failed - log but don't fail the run
            next[idx] = {
              ...next[idx],
              autoManage: {
                ...(next[idx].autoManage || {}),
                lastStopRescueAt: now,
                lastStopRescueStatus: "FAIL",
                lastStopRescueError: rescueNote,
              },
              updatedAt: now,
            };
            notes.push(`stop_rescue_fail:${ticker}:${rescueNote}`);
            hadFailures = true;
          }
        }
      } catch (rescueErr: any) {
        notes.push(`stop_rescue_exception:${ticker}:${String(rescueErr?.message || rescueErr)}`);
      }

      const changedStop = Math.abs(nextStop - stop) > 1e-6;
      let stopSyncOk = true;
      let stopSyncNote = "";

      if (changedStop) {
        const res = await syncStopForTrade(next[idx], nextStop);
        if (res.ok) {
          next[idx] = {
            ...next[idx],
            quantity: res.qty,
            stopPrice: nextStop,
            stopOrderId: res.stopOrderId,
            autoManage: {
              ...(next[idx].autoManage || {}),
              lastStopSyncAt: now,
              lastStopSyncStatus: "OK",
              lastStopSyncCancelled: res.cancelled,
            },
            updatedAt: now,
            error: undefined,
          };
          if (res.quantizationNote) {
            notes.push(`quantize:${ticker}:${res.quantizationNote}`);
          }
        } else {
          stopSyncOk = false;
          stopSyncNote = `${res.error}${res.detail ? ":" + res.detail : ""}`;
          if (res.quantizationNote) {
            stopSyncNote += ` [${res.quantizationNote}]`;
          }
          next[idx] = {
            ...next[idx],
            autoManage: {
              ...(next[idx].autoManage || {}),
              lastStopSyncAt: now,
              lastStopSyncStatus: "FAIL",
              lastStopSyncError: stopSyncNote,
            },
            updatedAt: now,
          };
        }
      }

      const noteRule = unrealizedR >= 2 ? `LOCK_2R_${tradeGrade}` : unrealizedR >= gradeRule.breakEvenAtR ? `BE_${gradeRule.breakEvenAtR}R_${tradeGrade}` : `NONE_${tradeGrade}`;
      const stopFrom = r2(stop);
      const stopTo = r2(nextStop);
      const px2 = r2(px);
      let syncTag = "";
      if (changedStop) {
        syncTag = stopSyncOk ? " sync:OK" : " sync:FAIL";
      }
      notes.push(
        `t:${ticker} r:${unrealizedR.toFixed(3)} px:${px2.toFixed(2)} stop:${stopFrom.toFixed(2)}→${stopTo.toFixed(2)} rule:${noteRule}${syncTag}`
      );

      next[idx] = {
        ...next[idx],
        lastPrice: r2(px),
        unrealizedPnL,
        unrealizedR,
        autoManage: {
          ...(next[idx].autoManage || {}),
          lastRunAt: now,
          lastRule: noteRule,
          trailEnabled: cfg.trailEnabled,
        },
      };

      if (!stopSyncOk) {
        notes.push(`stop_sync_fail:${ticker}:${stopSyncNote}`);
        hadFailures = true;
      } else if (changedStop) {
        notes.push(`stop_sync_ok:${ticker}`);
      }

      updated++;
    }
  }

  if (updated > 0) await writeTrades(next);

  await recordAutoManage({
    ts: now,
    outcome: hadFailures ? "FAIL" : "SUCCESS",
    reason: hadFailures ? "stop_sync_failed" : undefined,
    source: opts.source,
    runId: opts.runId,
    checked,
    updated,
    flattened,
    rescueAttempted: rescueAttempted || undefined,
    rescueOk: rescueOk || undefined,
    rescueFailed: rescueFailed || undefined,
  });

  const notesCapped = notes.slice(0, 50);
  return { ok: true, checked, updated, flattened, enabled: true, now, market: clock, notes: notesCapped, forced: force ? true : undefined, cfg, reconcile: reconcileResult };
}
