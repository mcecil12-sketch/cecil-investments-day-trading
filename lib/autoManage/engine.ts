import { getAutoManageConfig } from "@/lib/autoManage/config";
import { recordAutoManage } from "@/lib/autoManage/telemetry";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import { getLatestQuote, alpacaRequest } from "@/lib/alpaca";
import { syncStopForTrade } from "@/lib/autoManage/stopSync";

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
  cfg: ReturnType<typeof getAutoManageConfig>;
};

const num = (v: any) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

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

export async function runAutoManage(opts: { source?: string; runId?: string }): Promise<AutoManageResult> {
  const cfg = getAutoManageConfig();
  const now = new Date().toISOString();
  const notes: string[] = [];

  if (!cfg.enabled) {
    await recordAutoManage({ ts: now, outcome: "SKIP", reason: "disabled", source: opts.source, runId: opts.runId });
    return { ok: true, skipped: true, reason: "disabled", checked: 0, updated: 0, flattened: 0, enabled: false, now, cfg };
  }

  const clock = await getClockSafe();
  const marketClosed = isMarketClosed(clock);

  const all = await readTrades();
  const open = (all || []).filter((t: any) => String(t.status || "").toUpperCase() === "OPEN");

  if (!open.length) {
    await recordAutoManage({ ts: now, outcome: "SKIP", reason: "no_open_trades", source: opts.source, runId: opts.runId });
    return { ok: true, skipped: true, reason: "no_open_trades", checked: 0, updated: 0, flattened: 0, enabled: true, now, market: clock, cfg };
  }

  if (marketClosed && !cfg.eodFlatten) {
    await recordAutoManage({ ts: now, outcome: "SKIP", reason: "market_closed", source: opts.source, runId: opts.runId });
    return { ok: true, skipped: true, reason: "market_closed", checked: 0, updated: 0, flattened: 0, enabled: true, now, market: clock, cfg };
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
    const unrealizedPnL = pnlPerShare * qty;
    const unrealizedR = pnlPerShare / rps;

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
        } else {
          stopSyncOk = false;
          stopSyncNote = `${res.error}${res.detail ? ":" + res.detail : ""}`;
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

      next[idx] = {
        ...next[idx],
        lastPrice: px,
        unrealizedPnL,
        unrealizedR,
        autoManage: {
          ...(next[idx].autoManage || {}),
          lastRunAt: now,
          lastRule: unrealizedR >= 2 ? "LOCK_2R" : unrealizedR >= 1 ? "BE_1R" : "NONE",
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

  return { ok: true, checked, updated, flattened, enabled: true, now, market: clock, notes, cfg };
}
