import { getAutoManageConfig } from "@/lib/autoManage/config";
import { recordAutoManage } from "@/lib/autoManage/telemetry";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import { getLatestQuote, alpacaRequest } from "@/lib/alpaca";
import { syncStopForTrade } from "@/lib/autoManage/stopSync";
import { reconcileOpenTrades } from "@/lib/maintenance/reconcileOpenTrades";

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
  const open = (all || []).filter((t: any) => String(t.status || "").toUpperCase() === "OPEN");

  if (!open.length) {
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
  let hadFailures = false;

  const next = [...all];
  const max = Math.min(cfg.maxPerRun, open.length);

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

    let nextStop = stop;

    if (unrealizedR >= 1) {
      nextStop = side === "SHORT" ? Math.min(nextStop, entry) : Math.max(nextStop, entry);
    }
    if (unrealizedR >= 2) {
      const lock = side === "SHORT" ? (entry - rps) : (entry + rps);
      nextStop = side === "SHORT" ? Math.min(nextStop, lock) : Math.max(nextStop, lock);
    }
    if (cfg.trailEnabled && unrealizedR >= cfg.trailStartR) {
      const trailStop = side === "SHORT" ? px * (1 + cfg.trailPct) : px * (1 - cfg.trailPct);
      nextStop = side === "SHORT" ? Math.min(nextStop, trailStop) : Math.max(nextStop, trailStop);
    }

    const idx = next.findIndex((x: any) => x.id === id);
    if (idx >= 0) {
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

      const noteRule = unrealizedR >= 2 ? "LOCK_2R" : unrealizedR >= 1 ? "BE_1R" : "NONE";
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
  });

  const notesCapped = notes.slice(0, 50);
  return { ok: true, checked, updated, flattened, enabled: true, now, market: clock, notes: notesCapped, forced: force ? true : undefined, cfg, reconcile: reconcileResult };
}
