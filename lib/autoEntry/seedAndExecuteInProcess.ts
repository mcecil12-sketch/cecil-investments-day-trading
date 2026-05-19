/**
 * In-process real-time seed + execute trigger.
 *
 * Called directly from score/drain AFTER a signal is persisted as SCORED+qualified=true,
 * bypassing the HTTP round-trip that caused latency / silent failures in Phase 8.
 *
 * Design:
 *  - All validation is in-process (no HTTP to seed-from-signals)
 *  - Trade creation is in-process (upsertTrade called directly)
 *  - Execute trigger is still HTTP (execute route is too complex to inline)
 *  - Returns signalPatches so the caller can apply them to the StoredSignal before writeSignals
 */

import { upsertTrade, readTrades } from "@/lib/tradesStore";
import { bumpTodayFunnel } from "@/lib/funnelRedis";
import { getGuardrailsState } from "./guardrailsStore";
import { getGuardrailConfig } from "./guardrails";
import { getAutoConfig, tierForScore, riskMultForTier, type AutoTier } from "./config";
import { deriveSessionMeta } from "./eligibility";
import { normalizeTradePlanForSide } from "@/lib/trades/planNormalization";
import { getEtDateString } from "@/lib/time/etDate";

// Max age to consider a signal "fresh" in the real-time seed path.
// Uses scoredAt first (set by drain), falls back to createdAt.
// Signals scored <20 min ago are eligible; older ones wait for the next cron cycle.
const REAL_TIME_FRESH_MAX_MS = 20 * 60_000;

function parseTimestampMs(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Treat as unix seconds if value looks like epoch-seconds (< year 2001 in ms = 9.78e11)
    return raw < 1e12 ? raw * 1000 : raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const asNum = Number(trimmed);
    if (Number.isFinite(asNum) && asNum > 0) return asNum < 1e12 ? asNum * 1000 : asNum;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Returns how old the signal is in ms, preferring scoredAt over createdAt. */
function signalFreshnessAgeMs(signal: any, nowMs: number): number {
  const tsMs =
    parseTimestampMs(signal?.scoredAt) ??
    parseTimestampMs(signal?.createdAt) ??
    parseTimestampMs(signal?.updatedAt);
  if (tsMs == null) return Number.POSITIVE_INFINITY;
  return Math.max(0, nowMs - tsMs);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export type RealTimeSeedResult = {
  attempted: boolean;
  seeded: boolean;
  executed: boolean;
  skippedReason: string | null;
  tradeId: string | null;
  signalId: string;
  symbol: string;
  freshnessAgeMs: number;
  source: "score-drain-realtime";
  /** Partial signal fields to merge back onto the StoredSignal in the caller. */
  signalPatches: Record<string, unknown>;
  executeResult: {
    ok: boolean;
    status?: number;
    executedCount?: number | null;
    error?: string | null;
  } | null;
};

export type RealTimeSeedOptions = {
  source: "score-drain-realtime";
  runId: string;
  isMarketOpen: boolean;
  immediateExecute?: boolean;
  executeBaseUrl?: string;
  cronToken?: string;
  autoEntryToken?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Main function
// ─────────────────────────────────────────────────────────────────────────────

export async function seedAndMaybeExecuteQualifiedSignal(
  signal: any,
  opts: RealTimeSeedOptions,
): Promise<RealTimeSeedResult> {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const signalId = String(signal?.id || "").trim();
  const symbol = String(signal?.ticker || signal?.symbol || "").trim().toUpperCase();

  const base: RealTimeSeedResult = {
    attempted: true,
    seeded: false,
    executed: false,
    skippedReason: null,
    tradeId: null,
    signalId,
    symbol,
    freshnessAgeMs: 0,
    source: "score-drain-realtime",
    signalPatches: { realTimeSeedAttemptedAt: nowIso },
    executeResult: null,
  };

  const skip = (reason: string): RealTimeSeedResult => {
    base.skippedReason = reason;
    base.signalPatches.realTimeSeedSkippedReason = reason;
    return base;
  };

  // ── 1. Basic signal validation ────────────────────────────────────────────
  if (!signalId) return skip("missing_signal_id");
  if (!symbol) return skip("missing_symbol");
  if (signal?.status !== "SCORED") return skip("not_scored");
  if (signal?.qualified !== true) return skip("not_qualified");

  // ── 2. Market open ────────────────────────────────────────────────────────
  if (!opts.isMarketOpen) return skip("market_closed");

  // ── 3. Freshness (scoredAt > createdAt > updatedAt) ───────────────────────
  const freshnessAgeMs = signalFreshnessAgeMs(signal, nowMs);
  base.freshnessAgeMs = freshnessAgeMs;
  if (!Number.isFinite(freshnessAgeMs) || freshnessAgeMs > REAL_TIME_FRESH_MAX_MS) {
    return skip("stale_for_realtime");
  }

  // ── 4. Direction + trade plan ─────────────────────────────────────────────
  const direction = String(
    signal?.bestDirection || signal?.direction || signal?.aiDirection || "",
  )
    .trim()
    .toUpperCase();
  if (direction !== "LONG" && direction !== "SHORT") return skip("missing_direction");

  const entry = Number(signal?.entryPrice);
  const stop = Number(signal?.stopPrice);
  const target = Number(signal?.targetPrice ?? signal?.takeProfitPrice);
  if (
    !(
      Number.isFinite(entry) &&
      entry > 0 &&
      Number.isFinite(stop) &&
      stop > 0 &&
      Number.isFinite(target) &&
      target > 0
    )
  ) {
    return skip("missing_trade_plan");
  }

  // ── 5. Normalize plan (enforces tick size, side sanity) ───────────────────
  const plan = normalizeTradePlanForSide({
    side: direction as "LONG" | "SHORT",
    entryPrice: entry,
    stopPrice: stop,
    targetPrice: target,
    rewardMultiple: 2,
  });
  if (!plan.ok) return skip("invalid_trade_plan_for_side");

  // ── 6. Guardrail config (sync env-based) ──────────────────────────────────
  const guardConfig = getGuardrailConfig();
  if (!guardConfig.enabled) return skip("auto_entry_disabled");

  // ── 7. Guardrail state (Redis) ────────────────────────────────────────────
  const etDate = getEtDateString();
  let guardState: Awaited<ReturnType<typeof getGuardrailsState>>;
  try {
    guardState = await getGuardrailsState(etDate);
  } catch {
    return skip("guardrail_state_unavailable");
  }

  if (guardState.autoDisabledReason) {
    return skip(`auto_disabled:${String(guardState.autoDisabledReason).slice(0, 50)}`);
  }

  const entriesToday = guardState.entriesToday ?? 0;
  if (entriesToday >= guardConfig.maxEntriesPerDay) return skip("max_entries_per_day");

  // ── 8. Auto-entry config + tier ───────────────────────────────────────────
  const cfg = getAutoConfig();
  const aiScoreRaw = Number(signal?.aiScore ?? signal?.score ?? signal?.ai?.score ?? 0);
  const aiScore = Number.isFinite(aiScoreRaw) ? aiScoreRaw : 0;
  const tier = tierForScore(aiScore) ?? "C";

  if (!cfg.allowedTiers.includes(tier as AutoTier)) return skip("tier_disabled");

  // ── 9. Duplicate check against active trades ──────────────────────────────
  let existingTrades: any[] = [];
  try {
    existingTrades = await readTrades<any>();
  } catch {
    existingTrades = [];
  }

  const activeStatuses = new Set(["AUTO_PENDING", "OPEN", "NEW", "BROKER_PENDING"]);

  const hasBySignalId = existingTrades.some(
    (t: any) =>
      String(t?.signalId || "") === signalId &&
      activeStatuses.has(String(t?.status || "").toUpperCase()),
  );
  if (hasBySignalId) return skip("duplicate_by_signal_id");

  const hasBySymbolSide = existingTrades.some(
    (t: any) =>
      String(t?.ticker || t?.symbol || "").toUpperCase() === symbol &&
      String(t?.side || "").toUpperCase() === direction &&
      ["AUTO_PENDING", "OPEN", "NEW"].includes(String(t?.status || "").toUpperCase()) &&
      String(t?.etDate || "") === etDate,
  );
  if (hasBySymbolSide) return skip("duplicate_symbol_side_today");

  // ── 10. Create AUTO_PENDING trade ─────────────────────────────────────────
  const sessionMeta = deriveSessionMeta(nowIso);
  const tradeId = crypto.randomUUID();
  const scoredAt = String(signal?.scoredAt || signal?.createdAt || nowIso);
  const riskMult = riskMultForTier(tier as AutoTier);

  const trade = {
    id: tradeId,
    symbol,
    ticker: symbol,
    side: direction,
    entryPrice: plan.normalizedEntryPrice,
    stopPrice: plan.normalizedStopPrice,
    targetPrice: plan.normalizedTargetPrice,
    takeProfitPrice: plan.normalizedTargetPrice,
    status: "AUTO_PENDING",
    source: "AUTO",
    paper: true,
    createdAt: nowIso,
    updatedAt: nowIso,
    scoredAt,
    etDate: sessionMeta.etDate,
    sessionTag: sessionMeta.sessionTag,
    signalId,
    aiScore,
    tier,
    ai: {
      score: aiScore,
      tier,
      grade: signal?.aiGrade ?? null,
      riskMult,
      riskDollars: cfg.baseRiskDollars * riskMult,
      qualified: aiScore > 0,
      summary: "",
    },
    autoEntryStatus: "AUTO_PENDING",
    seededAt: nowIso,
    executeOutcome: "PENDING",
    executeReason: null as null,
    realTimeSeeded: true,
    realTimeSeedSource: opts.source,
    realTimeSeedRunId: opts.runId,
  };

  try {
    await upsertTrade(trade);
  } catch (err) {
    return skip(`trade_create_error:${String(err).slice(0, 60)}`);
  }

  base.seeded = true;
  base.tradeId = tradeId;
  base.signalPatches.realTimeSeedTradeId = tradeId;
  base.signalPatches.realTimeExecuteTriggered = false;

  // ── 11. Bump seed funnel counters ──────────────────────────────────────────
  try {
    await bumpTodayFunnel({
      seedCreatedCount: 1,
      seedRealTimeSeeded: 1,
      realTimeSeedAttemptedCount: 1,
      ...(direction === "LONG"
        ? { seedFromQualifiedLong: 1 }
        : { seedFromQualifiedShort: 1 }),
    });
  } catch {
    // Non-fatal telemetry
  }

  // ── 12. Immediate execute trigger (HTTP to execute route) ─────────────────
  if (opts.immediateExecute !== false && opts.executeBaseUrl) {
    const exeRunId = `rt_exe_${opts.runId}_${tradeId.slice(0, 8)}`;
    const exeUrl = `${opts.executeBaseUrl}/api/auto-entry/execute?source=realtime_seed&runId=${encodeURIComponent(exeRunId)}`;
    const exeHeaders: Record<string, string> = {
      "content-type": "application/json",
      "x-run-source": "realtime_seed",
      "x-run-id": exeRunId,
    };
    if (opts.cronToken) exeHeaders["x-cron-token"] = opts.cronToken;
    if (opts.autoEntryToken) exeHeaders["x-auto-entry-token"] = opts.autoEntryToken;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6_000);
    try {
      const resp = await fetch(exeUrl, {
        method: "POST",
        headers: exeHeaders,
        body: JSON.stringify({
          source: "realtime_seed",
          runId: exeRunId,
          signalId,
          tradeId,
        }),
        cache: "no-store",
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const payload: any = await resp.json().catch(() => ({}));
      const execCount = Number(payload?.executedCount ?? payload?.executed ?? 0);
      base.executed = Number.isFinite(execCount) && execCount > 0;
      base.executeResult = {
        ok: resp.ok,
        status: resp.status,
        executedCount: Number.isFinite(execCount) ? execCount : null,
        error: !resp.ok
          ? String(payload?.error || payload?.reason || "execute_http_error").slice(0, 100)
          : null,
      };
      base.signalPatches.realTimeExecuteTriggered = true;
      if (!base.executed) {
        base.signalPatches.realTimeExecuteSkippedReason = String(
          payload?.reason || payload?.skipReason || "not_executed",
        ).slice(0, 100);
      }
      await bumpTodayFunnel({
        seedImmediateExecuteTriggered: 1,
        ...(base.executed
          ? { immediateExecuteSucceededCount: 1 }
          : { immediateExecuteSkippedCount: 1 }),
      }).catch(() => null);
    } catch (exeErr: any) {
      clearTimeout(timer);
      const isTimeout = exeErr?.name === "AbortError";
      base.executeResult = {
        ok: false,
        error: isTimeout ? "execute_timeout_6s" : String(exeErr || "error").slice(0, 100),
      };
      base.signalPatches.realTimeExecuteSkippedReason = isTimeout
        ? "execute_timeout"
        : "execute_error";
      await bumpTodayFunnel({
        seedImmediateExecuteTriggered: 1,
        immediateExecuteSkippedCount: 1,
      }).catch(() => null);
    }
  }

  return base;
}
