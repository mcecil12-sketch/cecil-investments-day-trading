import { getAutoManageConfig } from "@/lib/autoManage/config";
import { getRuleForGrade, shouldMoveToBreakEven, shouldEnableTrailing } from "@/lib/autoManage/gradeRules";
import { recordAutoManage } from "@/lib/autoManage/telemetry";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import { getLatestQuote, alpacaRequest, getPositions, createOrder } from "@/lib/alpaca";
import { syncStopForTrade, rescueStop } from "@/lib/autoManage/stopSync";
import { reconcileOpenTrades } from "@/lib/maintenance/reconcileOpenTrades";
import { sendNotification } from "@/lib/notifications/notify";
import { selectCanonicalOpenTrade } from "@/lib/trades/canonical";
import { evaluateCutLoss } from "@/lib/autoManage/cutLoss";
import { computeUnrealizedR, decideReplacement } from "@/lib/autoManage/risk";
import { hydrateOpenTradeFromBroker } from "@/lib/autoManage/hydration";

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

function collectStopBySymbol(order: any, out: Map<string, number>) {
  const symbol = String(order?.symbol || "").toUpperCase();
  const stop = num(order?.stop_price ?? order?.stopPrice ?? order?.stop_loss?.stop_price);
  const type = String(order?.type || "").toLowerCase();
  const isStopLike = type.includes("stop") || stop != null;

  if (symbol && isStopLike && stop != null && stop > 0 && !out.has(symbol)) {
    out.set(symbol, stop);
  }

  const legs = Array.isArray(order?.legs) ? order.legs : [];
  for (const leg of legs) {
    collectStopBySymbol(leg, out);
  }
}

async function fetchOpenStopBySymbol() {
  const out = new Map<string, number>();
  try {
    const resp = await alpacaRequest({ method: "GET", path: "/v2/orders?status=open&nested=true&limit=500" });
    if (!resp.ok) return out;
    const parsed = JSON.parse(resp.text || "[]");
    const orders = Array.isArray(parsed) ? parsed : [];
    for (const order of orders) {
      collectStopBySymbol(order, out);
    }
  } catch {}
  return out;
}

async function fetchLatestBarClose(ticker: string): Promise<number | null> {
  try {
    const resp = await alpacaRequest({
      method: "GET",
      path: `/v2/stocks/${encodeURIComponent(ticker)}/bars/latest?timeframe=1Min`,
    });
    if (!resp.ok) return null;
    const parsed = JSON.parse(resp.text || "{}");
    const bar = (parsed as any)?.bar || (parsed as any)?.bars?.[ticker] || parsed;
    const close = num((bar as any)?.c ?? (bar as any)?.close ?? (bar as any)?.close_price);
    return close != null && close > 0 ? close : null;
  } catch {
    return null;
  }
}

function riskPerShare(entry: number, stop: number) {
  const r = Math.abs(entry - stop);
  return r > 0 ? r : null;
}

function hasValidRiskFields(trade: any) {
  const entry = Number(trade?.entryPrice);
  const stop = trade?.stopPrice;
  const takeProfit = trade?.takeProfitPrice ?? trade?.targetPrice;
  return Number.isFinite(entry) && entry > 0 && stop != null && takeProfit != null;
}

async function computeUnrealizedMetrics(args: {
  side: string;
  entry: number | null;
  stop: number | null;
  qty: number;
  currentPrice: number | null;
}): Promise<
  | { ok: true; px: number; entry: number; qty: number; unrealizedPnL: number; unrealizedR: number }
  | { ok: false; reason: string }
> {
  const entry = args.entry;
  const stop = args.stop;
  const px = args.currentPrice;
  const qty = args.qty;

  if (entry == null || !Number.isFinite(entry) || entry <= 0) {
    return { ok: false, reason: "missing_entry" };
  }
  if (stop == null || !Number.isFinite(stop) || stop <= 0) {
    return { ok: false, reason: "missing_stop" };
  }
  if (px == null || !Number.isFinite(px) || px <= 0) {
    return { ok: false, reason: "missing_price" };
  }
  if (!Number.isFinite(qty) || qty <= 0) {
    return { ok: false, reason: "missing_qty" };
  }

  let rReason = "unknown";
  const unrealizedRRaw = computeUnrealizedR({
    side: args.side,
    qty,
    entryPrice: entry,
    stopPrice: stop,
    currentPrice: px,
    clampAbs: 50,
    onInvalid: (reason) => {
      rReason = reason;
    },
  });

  if (unrealizedRRaw == null) {
    return { ok: false, reason: `r_compute_${rReason}` };
  }

  const pnlPerShare = String(args.side || "").toUpperCase() === "SHORT" ? (entry - px) : (px - entry);
  return {
    ok: true,
    px,
    entry,
    qty,
    unrealizedPnL: r2(pnlPerShare * qty),
    unrealizedR: r3(unrealizedRRaw),
  };
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

function getEtWeekdayHourMinute(d: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);

  const weekdayLabel = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "NaN");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "NaN");

  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    weekday: weekdayMap[weekdayLabel] ?? -1,
    hour: Number.isFinite(hour) ? hour : -1,
    minute: Number.isFinite(minute) ? minute : -1,
  };
}

function parseHourMinute(value: string) {
  const m = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function isNearEodWindowEt(nowIso: string, marketClosed: boolean) {
  if (marketClosed) return false;
  const now = new Date(nowIso);
  const et = getEtWeekdayHourMinute(now);
  return et.hour === 15 && et.minute >= 55;
}

function isFridayFlattenWindowEt(nowIso: string, afterEt: string, marketClosed: boolean) {
  if (marketClosed) return false;
  const now = new Date(nowIso);
  const et = getEtWeekdayHourMinute(now);
  if (et.weekday !== 5) return false;
  const cutoff = parseHourMinute(afterEt);
  if (!cutoff) return false;
  if (et.hour > cutoff.hour) return true;
  if (et.hour < cutoff.hour) return false;
  return et.minute >= cutoff.minute;
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
  const pushNote = (note: string) => {
    if (!note) return;
    if (notes.length < 120) notes.push(note);
  };
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
  if (reconcileNote) pushNote(`${reconcileNote}`);

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

      const isGhostBackfill =
        String(dup?.source || "") === "broker_backfill" &&
        !hasValidRiskFields(dup);

      const nextStatus = isGhostBackfill ? "ERROR" : "ARCHIVED";
      const nextReason = isGhostBackfill
        ? "invalid_backfill_missing_risk"
        : "duplicate_noncanonical";

      next[dupIdx] = {
        ...next[dupIdx],
        status: nextStatus,
        autoEntryStatus: "ARCHIVED_DUPLICATE_OPEN",
        error: nextReason,
        closeReason: nextReason,
        closedAt: next[dupIdx].closedAt || now,
        archivedAt: now,
        updatedAt: now,
      };
      duplicateArchived += 1;
      pushNote(`duplicate_archived:${ticker}:${dupId}:${nextReason}`);
    }

    pushNote(
      `dedupe:ticker=${ticker} canonical=${String(canonical?.id || "unknown")} skipped=[${duplicates
        .map((d: any) => String(d?.id || "unknown"))
        .join(",")}]`
    );
  }

  if (!open.length) {
    if (duplicateArchived > 0) {
      await writeTrades(next);
    }
    await recordAutoManage({ ts: now, outcome: "SKIP", reason: "no_open_trades", source: opts.source, runId: opts.runId });
    return { ok: true, skipped: true, reason: "no_open_trades", checked: 0, updated: 0, flattened: 0, enabled: true, now, market: clock, cfg, reconcile: reconcileResult };
  }

  if (marketClosed && !force) {
    await recordAutoManage({ ts: now, outcome: "SKIP", reason: "market_closed", source: opts.source, runId: opts.runId });
    return { ok: true, skipped: true, reason: "market_closed", checked: 0, updated: 0, flattened: 0, enabled: true, now, market: clock, cfg, reconcile: reconcileResult };
  }

  const flattenAllowedForce = force;
  const flattenAllowedEod = isNearEodWindowEt(now, marketClosed);
  const flattenAllowedFriday =
    cfg.fridayFlattenEnabled && isFridayFlattenWindowEt(now, cfg.fridayFlattenAfterEt, marketClosed);
  const flattenAllowed = flattenAllowedForce || flattenAllowedEod || flattenAllowedFriday;

  if (flattenAllowedForce) {
    pushNote("flatten_allowed_force");
  } else if (flattenAllowedEod) {
    pushNote("flatten_allowed_eod");
  } else if (flattenAllowedFriday) {
    pushNote("flatten_allowed_friday");
  } else {
    pushNote("flatten_skip_not_allowed");
  }

  let checked = 0;
  let updated = 0;
  let flattened = 0;
  let rescueAttempted = 0;
  let rescueOk = 0;
  let rescueFailed = 0;
  let replaceConsidered = 0;
  let replaceExecuted = 0;
  let hadFailures = false;
  const max = Math.min(cfg.maxPerRun, open.length);
  updated += duplicateArchived;

  const pendingCandidates = all
    .filter((t: any) => String(t?.status || "").toUpperCase() === "AUTO_PENDING")
    .map((t: any) => {
      const score = num(t?.aiScore ?? t?.score ?? t?.ai?.score);
      return {
        id: String(t?.id || ""),
        ticker: String(t?.ticker || "").toUpperCase(),
        score,
      };
    })
    .filter((t: any) => t.ticker);
  const topCandidate = [...pendingCandidates].sort((a, b) => (b.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? Number.NEGATIVE_INFINITY))[0] || null;
  if (!cfg.replaceEnabled) {
    pushNote("replace_skip_disabled");
  } else if (!topCandidate) {
    pushNote("replace_skip_no_candidates");
  }

  const openStopBySymbol = await fetchOpenStopBySymbol();
  const positionBySymbol = new Map<string, any>();
  try {
    const positionsRaw = await getPositions();
    const positions = Array.isArray(positionsRaw) ? positionsRaw : [positionsRaw];
    for (const p of positions) {
      const symbol = String((p as any)?.symbol || "").toUpperCase();
      if (symbol) positionBySymbol.set(symbol, p);
    }
  } catch {}

  for (let i = 0; i < max; i++) {
    const t: any = open[i];
    checked++;

    const id = String(t.id || "");
    const ticker = String(t.ticker || "").toUpperCase();
    const side = String(t.side || "LONG").toUpperCase();
    const idx = next.findIndex((x: any) => x.id === id);
    const brokerPos = positionBySymbol.get(ticker);

    const hydrated = hydrateOpenTradeFromBroker(t, brokerPos);
    let qty = hydrated.qty;
    let entry = hydrated.entryPrice;

    if (hydrated.qtyHydrated && qty != null && idx >= 0) {
      next[idx] = {
        ...next[idx],
        quantity: qty,
        qty,
        updatedAt: now,
      };
      updated++;
      pushNote(`hydrate_qty_from_broker:${ticker}`);
    }

    if (hydrated.entryHydrated && entry != null && idx >= 0) {
      next[idx] = {
        ...next[idx],
        entryPrice: entry,
        avgFillPrice: num(next[idx]?.avgFillPrice) ?? entry,
        updatedAt: now,
      };
      updated++;
      pushNote(`hydrate_entry_from_broker:${ticker}`);
    }

    if (!(qty != null && Number.isFinite(qty) && qty > 0)) {
      if (idx >= 0) {
        next[idx] = {
          ...next[idx],
          status: "ERROR",
          autoEntryStatus: "INVALID",
          error: "invalid_missing_qty_or_broker_match",
          reason: "invalid_missing_qty_or_broker_match",
          updatedAt: now,
        };
        updated++;
      }
      pushNote(`mark_invalid_missing_qty:${ticker}`);
      continue;
    }

    let stop = num(t.stopPrice);
    if (!(stop != null && stop > 0)) {
      const stopFromOrder = openStopBySymbol.get(ticker);
      if (stopFromOrder != null && stopFromOrder > 0) {
        stop = stopFromOrder;
        if (idx >= 0) {
          next[idx] = {
            ...next[idx],
            stopPrice: stopFromOrder,
            updatedAt: now,
          };
          updated++;
        }
        pushNote(`hydrate_stop_from_order:${ticker}`);
      }
    }

    if (!id || !ticker || !["LONG", "SHORT"].includes(side)) {
      pushNote(`skip_invalid:${id || ticker}`);
      continue;
    }

    if (!(stop != null && stop > 0)) {
      if (idx >= 0) {
        next[idx] = {
          ...next[idx],
          status: "ERROR",
          autoEntryStatus: "INVALID",
          error: "missing_stop_price",
          reason: "missing_stop_price",
          updatedAt: now,
        };
        updated++;
      }
      pushNote(`mark_invalid_missing_stop:${ticker}`);
      continue;
    }

    if (cfg.eodFlatten && flattenAllowed) {
      if (idx >= 0) {
        next[idx] = { ...next[idx], autoManage: { ...(next[idx].autoManage || {}), eodFlattenedAt: now } };
        updated++;
        flattened++;
      }
      continue;
    }

    let currentPrice: number | null = null;
    let priceSource = "none";

    const posPx = num((brokerPos as any)?.current_price);
    const posMv = num((brokerPos as any)?.market_value);
    if (posPx != null && posPx > 0) {
      currentPrice = posPx;
      priceSource = "position.current_price";
    } else if (posMv != null && posMv > 0 && Number.isFinite(qty) && qty > 0) {
      currentPrice = Math.abs(posMv) / qty;
      priceSource = "position.market_value";
    }

    let quotePx: number | null = null;
    if (currentPrice == null) {
      try {
        const q: any = await getLatestQuote(ticker);
        quotePx = midFromQuote(q);
      } catch {
        quotePx = null;
      }
      if (quotePx != null && quotePx > 0) {
        currentPrice = quotePx;
        priceSource = "quote.mid";
      }
    }

    if (currentPrice == null) {
      const barClose = await fetchLatestBarClose(ticker);
      if (barClose != null && barClose > 0) {
        currentPrice = barClose;
        priceSource = "bar.1Min.close";
      }
    }

    const metrics = await computeUnrealizedMetrics({
      side,
      entry,
      stop,
      qty,
      currentPrice,
    });
    if (!metrics.ok) {
      if (metrics.reason.startsWith("missing_")) {
        pushNote(`r_compute_failed_missing_fields:${ticker}`);
      }
      if (metrics.reason === "missing_price") {
        pushNote(`r_compute_failed_missing_price:${ticker}`);
      } else {
        pushNote(`r_compute_failed:${ticker}:${metrics.reason}`);
      }
      if (idx >= 0) {
        next[idx] = {
          ...next[idx],
          lastPrice: currentPrice != null ? r2(currentPrice) : next[idx]?.lastPrice,
          unrealizedR: null,
          autoManage: {
            ...(next[idx].autoManage || {}),
            lastRunAt: now,
            lastRule: "R_UNAVAILABLE",
            lastPriceSource: priceSource,
          },
          updatedAt: now,
        };
        updated++;
      }

      if (cfg.replaceEnabled) {
        const candidateTicker = String(topCandidate?.ticker || "").toUpperCase();
        const openScoreRaw = num(t?.aiScore ?? t?.score ?? t?.ai?.score);
        const openScore = openScoreRaw ?? 0;
        if (openScoreRaw == null) {
          pushNote(`replace_baseline_score_used:${ticker}`);
        }
        const decision = decideReplacement({
          openUnrealizedR: null,
          openScore,
          candidateScore: topCandidate?.score,
          allowUnknownROverride: cfg.replaceUnknownROverride,
          overrideScoreDelta: cfg.replaceScoreDelta,
        });
        replaceConsidered += 1;
        if (candidateTicker) {
          pushNote(`replace_considered:${ticker}->${candidateTicker}`);
        }
        if (decision.execute && candidateTicker && candidateTicker !== ticker) {
          const closeRes = await submitMarketCloseForTrade(t, ticker);
          if (closeRes.ok && idx >= 0) {
            replaceExecuted += 1;
            next[idx] = {
              ...next[idx],
              status: "CLOSED",
              autoEntryStatus: "CLOSED",
              closeReason: "replace_for_better_candidate",
              closeOrderId: closeRes.orderId,
              closeOrderStatus: closeRes.status,
              closedAt: now,
              updatedAt: now,
            };
            pushNote(`replace_executed:${ticker}->${candidateTicker}`);
            updated++;
            flattened++;
          } else {
            pushNote(`replace_skip_close_failed:${ticker}`);
            if (!closeRes.ok) hadFailures = true;
          }
        } else {
          if (candidateTicker && candidateTicker === ticker) {
            pushNote(`replace_skip_same_ticker:${ticker}`);
          } else if (decision.reason === "replace_skip_r_unknown") {
            pushNote(`replace_skip_r_unknown:${ticker}`);
          } else if (decision.reason === "replace_skip_r_positive") {
            pushNote(`replace_skip_r_positive:${ticker}`);
          } else if (decision.reason === "replace_skip_delta_too_small") {
            pushNote(`replace_skip_score_delta:${ticker}`);
          } else if (decision.reason === "replace_skip_no_candidates") {
            pushNote("replace_skip_no_candidates");
          }
        }
      }
      continue;
    }

    const unrealizedPnL = metrics.unrealizedPnL;
    const unrealizedR = metrics.unrealizedR;
    const px = metrics.px;
    const entryForCalc = metrics.entry;
    const rps = riskPerShare(entryForCalc, stop)!;

    if (cfg.replaceEnabled) {
      const candidateTicker = String(topCandidate?.ticker || "").toUpperCase();
      const openScoreRaw = num(t?.aiScore ?? t?.score ?? t?.ai?.score);
      const openScore = openScoreRaw ?? 0;
      if (openScoreRaw == null) {
        pushNote(`replace_baseline_score_used:${ticker}`);
      }
      const decision = decideReplacement({
        openUnrealizedR: unrealizedR,
        openScore,
        candidateScore: topCandidate?.score,
        allowUnknownROverride: cfg.replaceUnknownROverride,
        overrideScoreDelta: cfg.replaceScoreDelta,
      });
      replaceConsidered += 1;
      if (candidateTicker) {
        pushNote(`replace_considered:${ticker}->${candidateTicker}`);
      }
      if (decision.execute && candidateTicker && candidateTicker !== ticker) {
        const closeRes = await submitMarketCloseForTrade(t, ticker);
        if (closeRes.ok && idx >= 0) {
          replaceExecuted += 1;
          next[idx] = {
            ...next[idx],
            status: "CLOSED",
            autoEntryStatus: "CLOSED",
            closeReason: "replace_for_better_candidate",
            closeOrderId: closeRes.orderId,
            closeOrderStatus: closeRes.status,
            unrealizedPnL,
            unrealizedR,
            lastPrice: r2(px),
            closedAt: now,
            updatedAt: now,
          };
          pushNote(`replace_executed:${ticker}->${candidateTicker}`);
          updated++;
          flattened++;
          continue;
        }
        pushNote(`replace_skip_close_failed:${ticker}`);
        if (!closeRes.ok) hadFailures = true;
      } else {
        if (candidateTicker && candidateTicker === ticker) {
          pushNote(`replace_skip_same_ticker:${ticker}`);
        } else if (decision.reason === "replace_skip_r_unknown") {
          pushNote(`replace_skip_r_unknown:${ticker}`);
        } else if (decision.reason === "replace_skip_r_positive") {
          pushNote(`replace_skip_r_positive:${ticker}`);
        } else if (decision.reason === "replace_skip_delta_too_small") {
          pushNote(`replace_skip_score_delta:${ticker}`);
        } else if (decision.reason === "replace_skip_no_candidates") {
          pushNote("replace_skip_no_candidates");
        }
      }
    }

    const cutLossEvaluation = evaluateCutLoss({
      enabled: cfg.cutLossEnabled,
      thresholdR: cfg.cutLossR,
      trade: {
        id,
        ticker,
        status: "OPEN",
        unrealizedR,
      },
    });
    if (cutLossEvaluation.note) pushNote(cutLossEvaluation.note);
    const cutLossAction = cutLossEvaluation.action;

    if (cutLossAction) {
      const closeRes = await submitMarketCloseForTrade(t, ticker);

      if (!closeRes.ok) {
        pushNote(`cut_loss_fail:${ticker}:${closeRes.error}${closeRes.detail ? ":" + closeRes.detail : ""}`);
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

      pushNote(`cut_loss_exit:ticker=${ticker} r=${cutLossAction.r.toFixed(3)} qty=${closeRes.qty}`);

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
        pushNote(`cut_loss_notify_fail:${ticker}:${String(notifyErr?.message || notifyErr)}`);
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
      ? (stop <= entryForCalc + 0.001) // SHORT: stop at or below entry
      : (stop >= entryForCalc - 0.001); // LONG: stop at or above entry
    
    // Move to break-even based on grade rule
    if (shouldMoveToBreakEven(unrealizedR, tradeGrade, alreadyAtBreakEven)) {
      nextStop = entryForCalc; // Move stop to entry (break-even)
    }
    
    // Lock in 1R profit at 2R (applicable to all grades)
    if (unrealizedR >= 2.0 && !alreadyAtBreakEven) {
      const lock1R = side === "SHORT" ? (entryForCalc - rps) : (entryForCalc + rps);
      nextStop = side === "SHORT" ? Math.min(nextStop, lock1R) : Math.max(nextStop, lock1R);
    }
    
    // Apply trailing stop if grade rule allows and currentR qualifies
    if (shouldEnableTrailing(unrealizedR, tradeGrade) && cfg.trailEnabled) {
      const trailStop = side === "SHORT" ? px * (1 + cfg.trailPct) : px * (1 - cfg.trailPct);
      nextStop = side === "SHORT" ? Math.min(nextStop, trailStop) : Math.max(nextStop, trailStop);
    }

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
            pushNote(`stop_rescue_ok:${ticker}:${rescueNote}`);
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
            pushNote(`stop_rescue_fail:${ticker}:${rescueNote}`);
            hadFailures = true;
          }
        }
      } catch (rescueErr: any) {
        pushNote(`stop_rescue_exception:${ticker}:${String(rescueErr?.message || rescueErr)}`);
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
            pushNote(`quantize:${ticker}:${res.quantizationNote}`);
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
      pushNote(
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
        pushNote(`stop_sync_fail:${ticker}:${stopSyncNote}`);
        hadFailures = true;
      } else if (changedStop) {
        pushNote(`stop_sync_ok:${ticker}`);
      }

      updated++;
    }
  }

  if (replaceConsidered > 0 || replaceExecuted > 0) {
    pushNote(`replace_considered:${replaceConsidered}`);
    pushNote(`replace_executed:${replaceExecuted}`);
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
