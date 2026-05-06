import { NextRequest, NextResponse } from "next/server";
import { readTrades, writeTrades, upsertTrade } from "@/lib/tradesStore";
import { getAutoConfig, tierForScore, riskMultForTier, type AutoTier } from "@/lib/autoEntry/config";
import { deriveSessionMeta } from "@/lib/autoEntry/eligibility";
import { getEtDateString, getEtDayBoundsMs } from "@/lib/time/etDate";
import { readExecutionOverlays } from "@/lib/agents/overlays";
import { bumpTodayFunnel } from "@/lib/funnelRedis";
import { fetchBrokerTruth } from "@/lib/broker/truth";
import { getGuardrailsState } from "@/lib/autoEntry/guardrailsStore";
import { getGuardrailConfig } from "@/lib/autoEntry/guardrails";
import { fetchAlpacaClockSafe } from "@/lib/alpacaClock";
import { readSignals, writeSignals, type StoredSignal } from "@/lib/jsonDb";
import { upsertIncident, resolveIncident } from "@/lib/agents/store";
import {
  recordSeedRunTelemetry,
  type SeedRunTelemetry,
  type SeedSkipReason,
} from "@/lib/autoEntry/seedTelemetry";
import { normalizeTradePlanForSide } from "@/lib/trades/planNormalization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RawSignal = Record<string, any>;

// -------------------------------------------------------------------------
// Helper Functions
// -------------------------------------------------------------------------

function getNum(obj: any, paths: string[]): number | null {
  for (const path of paths) {
    const parts = path.split(".");
    let cur: any = obj;
    for (const p of parts) {
      if (cur == null) {
        cur = undefined;
        break;
      }
      cur = cur[p];
    }
    if (cur == null || cur === "") continue;
    const n = Number(cur);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function getStr(obj: any, paths: string[]): string | null {
  for (const path of paths) {
    const parts = path.split(".");
    let cur: any = obj;
    for (const p of parts) {
      if (cur == null) {
        cur = undefined;
        break;
      }
      cur = cur[p];
    }
    if (cur != null && cur !== "") return String(cur);
  }
  return null;
}

function getSymbol(signal: RawSignal): string {
  const raw = signal?.symbol ?? signal?.ticker;
  return String(raw || "").trim().toUpperCase();
}

function normalizeDirection(raw: any): "LONG" | "SHORT" | null {
  const d = String(raw || "").trim().toUpperCase();
  if (d === "LONG" || d === "SHORT") return d;
  return null;
}

function getDirection(signal: RawSignal): "LONG" | "SHORT" | null {
  return (
    normalizeDirection(signal?.bestDirection) ||
    normalizeDirection(signal?.direction) ||
    normalizeDirection(signal?.aiDirection) ||
    normalizeDirection(signal?.side)
  );
}

function normalizeTier(raw: unknown): "A" | "B" | "C" | null {
  const v = String(raw || "").trim().toUpperCase();
  if (v === "A" || v === "B" || v === "C") return v;
  return null;
}

function parseSignalsPayload(payload: any): RawSignal[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.signals)) return payload.signals;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function parseBoolFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  const v = String(value || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(v);
}

function mapSkipReason(raw: string): SeedSkipReason | null {
  switch (raw) {
    case "already_active_trade":
    case "already_terminal_trade":
    case "missing_prices":
    case "missing_direction":
    case "market_closed":
    case "capacity_full":
    case "below_threshold":
    case "stale_signal":
    case "duplicate_symbol":
    case "overlay_block":
    case "missing_signal_id":
    case "invalid_trade_plan_for_side":
    // C-tier quality block reasons (v2 performance upgrade)
    case "c_tier_quality_block":
    case "flat_trend_block":
    case "weak_volume_block":
    case "vwap_alignment_block":
    case "poor_rr_block":
      return raw;
    default:
      return null;
  }
}

function parseTimestampMs(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Interpret small epoch values as seconds and normalize to ms.
    return raw < 1e11 ? raw * 1000 : raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const asNum = Number(trimmed);
    if (Number.isFinite(asNum)) {
      return asNum < 1e11 ? asNum * 1000 : asNum;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function getSignalTimestampMs(signal: RawSignal): number | null {
  return (
    parseTimestampMs(signal?.createdAt) ??
    parseTimestampMs(signal?.scoredAt) ??
    parseTimestampMs(signal?.updatedAt)
  );
}

function bumpSkipReason(
  counts: Partial<Record<SeedSkipReason, number>>,
  reason: SeedSkipReason
) {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

// -------------------------------------------------------------------------
// Phase 3c: Short-Side Quality Enhancement
// -------------------------------------------------------------------------

type ShortQualityResult = {
  pass: boolean;
  reason: string | null;
  blockReason: SeedSkipReason | null;
};

/**
 * Strict short-side quality check.
 * Rejects shorts that are not below VWAP, not in lower-high/lower-low structure,
 * or lacking increasing volume on breakdown.
 */
function evaluateShortQuality(signal: RawSignal): ShortQualityResult {
  const reasons: string[] = [];

  const toBool = (v: unknown): boolean | null => {
    if (typeof v === "boolean") return v;
    const s = String(v ?? "").trim().toLowerCase();
    if (!s) return null;
    if (["1", "true", "yes", "y", "on"].includes(s)) return true;
    if (["0", "false", "no", "n", "off"].includes(s)) return false;
    return null;
  };

  // 1. Trend structure: lower highs / lower lows and downtrend alignment
  const trend = getStr(signal, ["trend", "ai.trend", "context.trend"]);
  const lowerHighs =
    toBool(signal?.lowerHighs) ??
    toBool(signal?.context?.lowerHighs) ??
    toBool(signal?.structure?.lowerHighs);
  const lowerLows =
    toBool(signal?.lowerLows) ??
    toBool(signal?.context?.lowerLows) ??
    toBool(signal?.structure?.lowerLows);

  if (lowerHighs === false || lowerLows === false) {
    return {
      pass: false,
      reason: "missing_lower_highs_lows",
      blockReason: "flat_trend_block",
    };
  }

  if (trend) {
    const trendLower = trend.toLowerCase();
    if (
      trendLower === "flat" ||
      trendLower === "neutral" ||
      trendLower === "up" ||
      trendLower === "bullish"
    ) {
      return {
        pass: false,
        reason: `trend=${trendLower}`,
        blockReason: "flat_trend_block",
      };
    }
  }

  // 2. VWAP alignment: shorts must be below VWAP.
  const vwapPosition = getStr(signal, ["vwapPosition", "ai.vwapPosition", "context.vwapPosition"]);
  const price = getNum(signal, ["entryPrice", "price", "lastPrice"]);
  const vwap = getNum(signal, ["vwap", "context.vwap"]);
  
  if (vwapPosition) {
    const vpLower = vwapPosition.toLowerCase();
    if (vpLower === "above" || vpLower.includes("above")) {
      return {
        pass: false,
        reason: "above_vwap",
        blockReason: "vwap_alignment_block",
      };
    }
  } else if (price && vwap && vwap > 0) {
    const distPct = ((price - vwap) / vwap) * 100;
    if (distPct >= 0) {
      return {
        pass: false,
        reason: `not_below_vwap:${distPct.toFixed(2)}%`,
        blockReason: "vwap_alignment_block",
      };
    }
  }

  // 3. Breakdown volume: must be increasing on breakdown.
  const breakdownVolumeIncreasing =
    toBool(signal?.breakdownVolumeIncreasing) ??
    toBool(signal?.context?.breakdownVolumeIncreasing) ??
    toBool(signal?.volume?.breakdownIncreasing);
  if (breakdownVolumeIncreasing === false) {
    return {
      pass: false,
      reason: "breakdown_volume_not_increasing",
      blockReason: "weak_volume_block",
    };
  }

  // 4. Relative volume check: shorts need decent volume.
  const relVol = getNum(signal, ["relVol", "relativeVolume", "context.relVol"]);
  if (relVol != null && relVol < 1.5) {
    return {
      pass: false,
      reason: `relVol=${relVol.toFixed(2)}<1.5`,
      blockReason: "weak_volume_block",
    };
  }

  return {
    pass: true,
    reason: reasons.length > 0 ? reasons.join(",") : null,
    blockReason: null,
  };
}

// -------------------------------------------------------------------------
// C-Tier Execution Quality Gate (v2 performance upgrade)
// -------------------------------------------------------------------------

type CTierQualityResult = {
  pass: boolean;
  blockReason: SeedSkipReason | null;
  debugNote: string;
};

/**
 * Evaluate C-tier execution quality gates.
 * Returns pass=false with a specific blockReason when the signal fails.
 * A/B tier signals are not evaluated here.
 */
function evaluateCTierQuality(
  signal: RawSignal,
  aiScore: number,
  side: "LONG" | "SHORT",
  cfg: {
    allowCTier: boolean;
    cMinScore: number;
    cMinRelVol: number;
    requireTrendAlignment: boolean;
    cMinRR: number;
  }
): CTierQualityResult {
  if (!cfg.allowCTier) {
    return { pass: false, blockReason: "c_tier_quality_block", debugNote: "AUTO_ENTRY_ALLOW_C_TIER=false" };
  }

  // Score gate
  if (aiScore < cfg.cMinScore) {
    return { pass: false, blockReason: "c_tier_quality_block", debugNote: `score ${aiScore.toFixed(2)} < cMinScore ${cfg.cMinScore}` };
  }

  // relVol gate
  const relVol = getNum(signal, ["relVol", "relativeVolume", "context.relVol", "signalContext.relVolume"]);
  if (relVol != null && relVol < cfg.cMinRelVol) {
    return { pass: false, blockReason: "weak_volume_block", debugNote: `relVol ${relVol.toFixed(2)} < cMinRelVol ${cfg.cMinRelVol}` };
  }
  if (relVol == null) {
    return { pass: false, blockReason: "weak_volume_block", debugNote: "relVol missing for C-tier" };
  }

  // Trend alignment gate
  if (cfg.requireTrendAlignment) {
    const trend = getStr(signal, ["trend", "trendBucket", "context.trend", "signalContext.trend", "ai.trendBucket"]);
    if (trend) {
      const tLower = trend.toLowerCase();
      if (side === "LONG" && (tLower === "flat" || tLower === "down" || tLower === "strong_down" || tLower === "weak_down")) {
        return { pass: false, blockReason: "flat_trend_block", debugNote: `trend=${trend} incompatible with LONG` };
      }
      if (side === "SHORT" && (tLower === "flat" || tLower === "neutral" || tLower === "up" || tLower === "strong_up" || tLower === "weak_up")) {
        return { pass: false, blockReason: "vwap_alignment_block", debugNote: `trend=${trend} incompatible with SHORT` };
      }
    }
    // Also check rejectionTags from scorer
    const rejectionTags: string[] = Array.isArray((signal as any).rejectionTags) ? (signal as any).rejectionTags : [];
    if (side === "LONG" && rejectionTags.includes("flat_trend_long")) {
      return { pass: false, blockReason: "flat_trend_block", debugNote: "rejectionTags includes flat_trend_long" };
    }
    if (side === "LONG" && rejectionTags.includes("below_vwap_long") && aiScore < cfg.cMinScore + 0.3) {
      return { pass: false, blockReason: "vwap_alignment_block", debugNote: `below_vwap_long at marginal C score ${aiScore.toFixed(2)}` };
    }
    if (side === "SHORT" && (rejectionTags.includes("poor_short_vwap") || rejectionTags.includes("uptrend_short"))) {
      return { pass: false, blockReason: "vwap_alignment_block", debugNote: `short rejectionTags: ${rejectionTags.join(",")}` };
    }
  }

  // R:R gate
  const entryPrice = getNum(signal, ["entryPrice", "price"]);
  const stopPrice = getNum(signal, ["stopPrice"]);
  const targetPrice = getNum(signal, ["targetPrice", "takeProfitPrice"]);
  if (entryPrice != null && stopPrice != null && targetPrice != null) {
    const risk = Math.abs(entryPrice - stopPrice);
    const reward = Math.abs(targetPrice - entryPrice);
    if (risk > 0 && reward / risk < cfg.cMinRR) {
      return { pass: false, blockReason: "poor_rr_block", debugNote: `R:R ${(reward / risk).toFixed(2)} < cMinRR ${cfg.cMinRR}` };
    }
  }

  return { pass: true, blockReason: null, debugNote: "passed_c_tier_quality_gate" };
}

// -------------------------------------------------------------------------
// Phase 3c: Candidate Deduplication & Ranking
// -------------------------------------------------------------------------

type QualifiedCandidate = {
  symbol: string;
  side: "LONG" | "SHORT";
  aiScore: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  originalEntryPrice: number;
  originalStopPrice: number;
  originalTargetPrice: number;
  normalizedForSide: boolean;
  tier: string;
  signalId: string;
  createdAt: string;
  shortPenalty: number;
  effectiveScore: number;
  actionabilityRank: number; // 1-10 from aiScoring, higher = more actionable
  ageMs: number;
};

/**
 * Deduplicate candidates by symbol+side, keeping only the best per group.
 * Returns unique candidates and count of collapsed duplicates.
 */
function dedupeCandidates(candidates: QualifiedCandidate[]): {
  unique: QualifiedCandidate[];
  collapsedCount: number;
} {
  const bySymbolSide = new Map<string, QualifiedCandidate[]>();
  
  for (const c of candidates) {
    const key = `${c.symbol}:${c.side}`;
    const existing = bySymbolSide.get(key) || [];
    existing.push(c);
    bySymbolSide.set(key, existing);
  }

  const unique: QualifiedCandidate[] = [];
  let collapsedCount = 0;

  for (const [, group] of bySymbolSide) {
    // Sort by effectiveScore DESC, then createdAt DESC (newest first)
    group.sort((a, b) => {
      if (b.effectiveScore !== a.effectiveScore) {
        return b.effectiveScore - a.effectiveScore;
      }
      // Secondary: actionability rank (continuation/breakout above mean-reversion)
      if (b.actionabilityRank !== a.actionabilityRank) {
        return b.actionabilityRank - a.actionabilityRank;
      }
      // Tie-breaker: newest signal first
      const aTime = new Date(a.createdAt).getTime() || 0;
      const bTime = new Date(b.createdAt).getTime() || 0;
      return bTime - aTime;
    });

    // Keep only the best
    unique.push(group[0]);
    collapsedCount += group.length - 1;
  }

  // Final sort: tier-priority first (A > B > C), then effectiveScore, then actionabilityRank, then freshest
  const tierWeight = (tier: string) => tier === "A" ? 3 : tier === "B" ? 2 : 1;
  unique.sort((a, b) => {
    const scoreDiff = b.aiScore - a.aiScore;
    if (Math.abs(scoreDiff) > 0.01) return scoreDiff;
    const tierDiff = tierWeight(b.tier) - tierWeight(a.tier);
    if (tierDiff !== 0) return tierDiff;
    // Within same tier+score band: prefer higher actionability then freshest signal
    const rankDiff = b.actionabilityRank - a.actionabilityRank;
    if (rankDiff !== 0) return rankDiff;
    // Freshest first within same tier/score/rank
    return (b.ageMs ?? Infinity) < (a.ageMs ?? Infinity) ? -1 : 1;
  });

  return { unique, collapsedCount };
}

async function fetchScoredSignalsFromInternalApi(): Promise<RawSignal[]> {
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? "http://127.0.0.1:3000";
  const url = `${base.replace(/\/$/, "")}/api/signals/all?since=48h&onlyActive=1&order=desc&limit=1000&statuses=SCORED`;
  const resp = await fetch(url, { method: "GET", cache: "no-store" });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`signals_all_fetch_failed:${resp.status}:${text.slice(0, 200)}`);
  }
  const json = await resp.json().catch(() => ({}));
  return parseSignalsPayload(json);
}

export async function POST(req: NextRequest) {
  const cronToken = req.headers.get("x-cron-token") || "";
  const autoToken = req.headers.get("x-auto-entry-token") || "";

  const okCron = !!process.env.CRON_TOKEN && cronToken === process.env.CRON_TOKEN;
  const okAuto = !!process.env.AUTO_ENTRY_TOKEN && autoToken === process.env.AUTO_ENTRY_TOKEN;

  if (!okCron && !okAuto) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const cfg = getAutoConfig();
  if (!cfg.enabled) {
    return NextResponse.json({ ok: true, skipped: true, reason: "AUTO_TRADING_ENABLED=false" }, { status: 200 });
  }

  const nowIso = new Date().toISOString();
  const runSource = req.headers.get("x-run-source") || "unknown";
  const runId = req.headers.get("x-run-id") || `seed-from-signals-${Date.now()}`;

  // Parse params from both URL query params and JSON body
  const url = new URL(req.url);
  const body = await req.json().catch(() => ({}));
  const limitRawQuery = url.searchParams.get("limit");
  const minScoreRawQuery = url.searchParams.get("minScore");

  const bodyLimit = typeof body?.limit === "number" && Number.isFinite(body.limit) ? body.limit : undefined;
  const bodyMinScore = typeof body?.minScore === "number" && Number.isFinite(body.minScore) ? body.minScore : undefined;
  const dryRun = parseBoolFlag(url.searchParams.get("dryRun")) || parseBoolFlag(body?.dryRun);
  const debug = parseBoolFlag(url.searchParams.get("debug")) || parseBoolFlag(body?.debug);

  const limitParsed = Number(limitRawQuery) || bodyLimit;
  const minScoreParsed = Number(minScoreRawQuery) || bodyMinScore;

  const requestedLimit =
    typeof limitParsed === "number" && Number.isFinite(limitParsed)
      ? Math.max(1, Math.min(50, limitParsed))
      : 3;
  const minScore = typeof minScoreParsed === "number" && Number.isFinite(minScoreParsed) ? minScoreParsed : 0;
  const minScoreProvided =
    (typeof minScoreRawQuery === "string" && url.searchParams.has("minScore")) ||
    (typeof bodyMinScore === "number" && Number.isFinite(bodyMinScore));

  const today = getEtDateString();
  const { startMs: dayStartMs, endMs: dayEndMs } = getEtDayBoundsMs(today);
  const guardConfig = getGuardrailConfig();
  const [rawSignals, trades, overlay, brokerTruth, guardState, clock, allStoredSignals] = await Promise.all([
    fetchScoredSignalsFromInternalApi(),
    readTrades<any>(),
    readExecutionOverlays(),
    fetchBrokerTruth(),
    getGuardrailsState(today),
    fetchAlpacaClockSafe(),
    readSignals(),
  ]);

  const marketOpen = clock.ok ? Boolean(clock.is_open) : false;
  const allowAfterHoursCreate = debug;

  // ─── Stale threshold: market-hours-aware ──────────────────────────────
  const freshMsParam = url.searchParams.has("freshMs") ? Number(url.searchParams.get("freshMs")) : null;
  const envFreshMs = process.env.AUTO_ENTRY_SIGNAL_FRESH_MS ? Number(process.env.AUTO_ENTRY_SIGNAL_FRESH_MS) : null;
  const legacyMinEnv = process.env.AUTO_ENTRY_SEED_MAX_AGE_MIN ? Number(process.env.AUTO_ENTRY_SEED_MAX_AGE_MIN) : null;
  const nowEtHour = (() => {
    try {
      const etParts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hour12: false }).formatToParts(new Date());
      const h = Number(etParts.find(p => p.type === "hour")?.value ?? 0);
      const m = Number(etParts.find(p => p.type === "minute")?.value ?? 0);
      return h + m / 60;
    } catch { return 10; }
  })();
  const isEodWindow = marketOpen && nowEtHour >= 14.5; // after 2:30 PM ET
  let staleThresholdUsedMs: number;
  let freshnessMode: string;
  if (freshMsParam != null && Number.isFinite(freshMsParam) && freshMsParam > 0) {
    staleThresholdUsedMs = freshMsParam;
    freshnessMode = "param_override";
  } else if (envFreshMs != null && Number.isFinite(envFreshMs) && envFreshMs > 0) {
    staleThresholdUsedMs = envFreshMs;
    freshnessMode = "env_override";
  } else if (legacyMinEnv != null && Number.isFinite(legacyMinEnv) && legacyMinEnv > 0) {
    staleThresholdUsedMs = Math.round(legacyMinEnv * 60_000);
    freshnessMode = "legacy_env_min";
  } else if (marketOpen && isEodWindow) {
    staleThresholdUsedMs = 75 * 60_000;
    freshnessMode = "eod_75m";
  } else if (marketOpen) {
    staleThresholdUsedMs = 60 * 60_000;
    freshnessMode = "market_default_60m";
  } else {
    staleThresholdUsedMs = 10 * 60_000;
    freshnessMode = "closed_default_10m";
  }
  const nowMs = Date.now();

  const signals = (rawSignals || []).filter((s: RawSignal) => {
    const tsMs = getSignalTimestampMs(s);
    if (tsMs == null || !Number.isFinite(tsMs)) return false;
    return tsMs >= dayStartMs && tsMs < dayEndMs;
  });
  const signalsFilteredOut = (rawSignals || []).length - signals.length;

  const currentOpenPositions = brokerTruth.positionsCount ?? 0;
  const maxOpenPositions = guardConfig.maxOpenPositions;
  const entriesToday = guardState.entriesToday ?? 0;
  const maxEntriesPerDay = guardConfig.maxEntriesPerDay;
  const remainingPositionSlots = Math.max(0, maxOpenPositions - currentOpenPositions);
  const remainingEntriesToday = Math.max(0, maxEntriesPerDay - entriesToday);

  let effectiveLimit = requestedLimit;
  let limitReason = "requested_limit";
  if (overlay.maxEntriesOverride != null && overlay.maxEntriesOverride >= 0 && overlay.maxEntriesOverride < effectiveLimit) {
    effectiveLimit = overlay.maxEntriesOverride;
    limitReason = "overlay_max_entries_override";
  }
  if (remainingPositionSlots < effectiveLimit) {
    effectiveLimit = remainingPositionSlots;
    limitReason = remainingPositionSlots === 0 ? "no_position_capacity" : "position_capacity";
  }
  if (remainingEntriesToday < effectiveLimit) {
    effectiveLimit = remainingEntriesToday;
    limitReason = remainingEntriesToday === 0 ? "entries_per_day_exhausted" : "entries_per_day";
  }
  effectiveLimit = Math.max(0, effectiveLimit);

  // ── Pre-seed stale trade cleanup ─────────────────────────────────────────
  // Archive stale AUTO_PENDING and error-blocked trades from previous runs that
  // would prevent fresh signals from being seeded via the already_active_trade
  // check. Uses the same max-age threshold as the execute route.
  {
    const _maxAgeMs = Math.max(1, Number.isFinite(Number(process.env.AUTO_ENTRY_MAX_AGE_MIN))
      ? Number(process.env.AUTO_ENTRY_MAX_AGE_MIN)
      : 30) * 60_000;
    const _blockingReasons = new Set(["rescore_required", "invalid_trade", "rescore_failed"]);
    let _cleanedCount = 0;
    const _tradesArr = trades as any[];
    for (let _ci = 0; _ci < _tradesArr.length; _ci++) {
      const _ct = _tradesArr[_ci];
      if (!_ct) continue;
      const _status = String(_ct?.status || "").toUpperCase();
      const _src = String(_ct?.source || "").toLowerCase();
      if (_src !== "auto-entry" && _src !== "auto") continue;
      const _shouldClean = (() => {
        if (_status === "AUTO_PENDING") {
          const _ts = Date.parse(String(_ct?.createdAt || _ct?.updatedAt || ""));
          if (!Number.isFinite(_ts)) return true; // no timestamp → stale
          if (nowMs - _ts > _maxAgeMs) return true; // older than max age
          // Previous ET date
          try {
            const _etDate = new Intl.DateTimeFormat("en-CA", {
              timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
            }).format(new Date(_ts));
            if (_etDate !== today) return true;
          } catch { return true; }
          return false;
        }
        if (_status === "ERROR") {
          return _blockingReasons.has(String(_ct?.executeReason || _ct?.reason || ""));
        }
        return false;
      })();
      if (!_shouldClean) continue;
      const _now2 = new Date().toISOString();
      _tradesArr[_ci] = {
        ..._ct,
        status: "ARCHIVED",
        autoEntryStatus: "AUTO_ARCHIVED",
        reason: "pre_seed_stale_cleanup",
        closedAt: _ct?.closedAt || _now2,
        updatedAt: _now2,
        executeOutcome: _ct?.executeOutcome || "SKIPPED_EXPIRED",
        executeReason: _ct?.executeReason || "pre_seed_stale_cleanup",
      };
      _cleanedCount++;
    }
    if (_cleanedCount > 0) {
      await writeTrades(_tradesArr);
      console.log("[seed-from-signals] pre-seed-cleanup archived", _cleanedCount);
    }
  }

  const activeStatuses = new Set(["AUTO_PENDING", "OPEN", "NEW"]);
  const terminalStatuses = new Set(["CLOSED", "HIT", "STOPPED", "CANCELED", "CANCELLED", "REJECTED", "ARCHIVED", "ERROR"]);
  const activeSignalIds = new Set<string>();
  const terminalSignalIds = new Set<string>();
  const activeSymbolSide = new Set<string>();

  for (const t of trades || []) {
    const sid = String(t?.signalId || "");
    const status = String(t?.status || "").toUpperCase();
    const symbol = String(t?.ticker || t?.symbol || "").toUpperCase();
    const side = normalizeDirection(t?.side);

    if (sid && activeStatuses.has(status)) activeSignalIds.add(sid);
    if (sid && terminalStatuses.has(status)) terminalSignalIds.add(sid);
    if (activeStatuses.has(status) && symbol && side) {
      activeSymbolSide.add(`${symbol}:${side}`);
    }
  }

  const created: any[] = [];
  const skipped: Array<{
    signalId: string;
    symbol: string;
    reason: string;
    side?: "LONG" | "SHORT" | null;
    originalEntryPrice?: number | null;
    originalStopPrice?: number | null;
    originalTargetPrice?: number | null;
    normalizedEntryPrice?: number | null;
    normalizedStopPrice?: number | null;
    normalizedTargetPrice?: number | null;
    normalizedForSide?: boolean;
    invalidReason?: string;
  }> = [];
  const skippedByReason: Partial<Record<SeedSkipReason, number>> = {};
  const attributionBySignalId = new Map<string, {
    symbol: string;
    seedOutcome: "created" | "skipped";
    seedReason: string;
    linkedTradeId: string | null;
    createdAt: string;
    ageMs: number | null;
    side: "LONG" | "SHORT" | null;
  }>();

  let shortQualified = 0;
  let shortSkippedWeakStructure = 0;
  let seededLong = 0;
  let seededShort = 0;
  const notQualifiedSkippedCount = (signals || []).filter((s) => s?.qualified !== true).length;

  const effectiveMinScore = minScoreProvided ? minScore : 0;
  const qualifiedSignals = (signals || []).filter((s) => {
    if (s?.qualified !== true) return false;
    const status = String(s?.status || "").toUpperCase();
    return status !== "ARCHIVED";
  }).sort((a, b) => {
    const aTs = getSignalTimestampMs(a) ?? 0;
    const bTs = getSignalTimestampMs(b) ?? 0;
    return bTs - aTs;
  });

  const qualifiedSignalAges: Array<{
    signalId: string;
    symbol: string;
    createdAt: string;
    ageMs: number;
    isFresh: boolean;
  }> = [];
  let freshQualifiedSignals = 0;
  let staleQualifiedSignals = 0;
  for (const s of qualifiedSignals) {
    const signalId = String(s?.id || "").trim();
    const symbol = getSymbol(s) || "UNKNOWN";
    const tsMs = getSignalTimestampMs(s);
    const ageMs = Number.isFinite(tsMs) ? Math.max(0, nowMs - (tsMs as number)) : Number.POSITIVE_INFINITY;
    if (Number.isFinite(ageMs) && ageMs <= staleThresholdUsedMs) freshQualifiedSignals += 1;
    else staleQualifiedSignals += 1;
    if (!signalId) continue;
    qualifiedSignalAges.push({
      signalId,
      symbol,
      createdAt: String(s?.createdAt || s?.updatedAt || nowIso),
      ageMs,
      isFresh: Number.isFinite(ageMs) && ageMs <= staleThresholdUsedMs,
    });
  }

  const allQualifyingCandidates: QualifiedCandidate[] = [];
  const candidateKey = (c: QualifiedCandidate) => `${c.signalId}:${c.symbol}:${c.side}:${c.createdAt}`;

  for (const s of qualifiedSignals || []) {

    const signalId = String(s?.id || "").trim();
    const symbol = getSymbol(s) || "UNKNOWN";
    const side = getDirection(s);
    const entryPrice = getNum(s, ["entryPrice", "ai.entryPrice"]);
    const stopPrice = getNum(s, ["stopPrice", "ai.stopPrice"]);
    const targetPrice = getNum(s, ["targetPrice", "takeProfitPrice", "ai.targetPrice", "ai.takeProfitPrice"]);
    const aiScoreRaw = getNum(s, ["aiScore", "score", "ai.score"]);
    const scoreTier = Number.isFinite(aiScoreRaw as number) ? tierForScore(aiScoreRaw as number) : null;
    const gradeTier = normalizeTier(getStr(s, ["aiGrade", "grade", "ai.grade"]));
    const tier = scoreTier || gradeTier;
    const aiScore = Number.isFinite(aiScoreRaw as number)
      ? (aiScoreRaw as number)
      : tier === "A"
        ? cfg.tierAmin
        : tier === "B"
          ? cfg.tierBmin
          : tier === "C"
            ? cfg.tierCmin
            : null;
    const createdAt = String(s?.createdAt || s?.updatedAt || nowIso);
    const createdAtMs = getSignalTimestampMs(s);
    const ageMs = Number.isFinite(createdAtMs) ? Math.max(0, nowMs - (createdAtMs as number)) : Number.POSITIVE_INFINITY;

    const markSkip = (
      reason: SeedSkipReason,
      planDiagnostics?: {
        originalEntryPrice?: number | null;
        originalStopPrice?: number | null;
        originalTargetPrice?: number | null;
        normalizedEntryPrice?: number | null;
        normalizedStopPrice?: number | null;
        normalizedTargetPrice?: number | null;
        normalizedForSide?: boolean;
        invalidReason?: string;
      },
    ) => {
      skipped.push({ signalId, symbol, reason, side, ...planDiagnostics });
      bumpSkipReason(skippedByReason, reason);
      if (!signalId) return;
      attributionBySignalId.set(signalId, {
        symbol,
        seedOutcome: "skipped",
        seedReason: reason,
        linkedTradeId: null,
        createdAt,
        ageMs,
        side,
      });
    };

    if (!signalId) {
      markSkip("missing_signal_id");
      continue;
    }

    if (!side) {
      markSkip("missing_direction");
      continue;
    }

    if (!(entryPrice != null && entryPrice > 0 && stopPrice != null && stopPrice > 0 && targetPrice != null && targetPrice > 0)) {
      markSkip("missing_prices");
      continue;
    }

    const normalizedPlan = normalizeTradePlanForSide({
      side,
      entryPrice,
      stopPrice,
      targetPrice,
      rewardMultiple: 2,
    });

    if (!normalizedPlan.ok) {
      markSkip("invalid_trade_plan_for_side", {
        originalEntryPrice: normalizedPlan.originalEntryPrice,
        originalStopPrice: normalizedPlan.originalStopPrice,
        originalTargetPrice: normalizedPlan.originalTargetPrice,
        normalizedEntryPrice: normalizedPlan.normalizedEntryPrice,
        normalizedStopPrice: normalizedPlan.normalizedStopPrice,
        normalizedTargetPrice: normalizedPlan.normalizedTargetPrice,
        normalizedForSide: normalizedPlan.normalizedForSide,
        invalidReason: normalizedPlan.invalidReason,
      });
      continue;
    }

    if (effectiveMinScore > 0 && (!Number.isFinite(aiScore as number) || (aiScore as number) < effectiveMinScore)) {
      markSkip("below_threshold");
      continue;
    }

    if (!Number.isFinite(ageMs) || ageMs > staleThresholdUsedMs) {
      markSkip("stale_signal");
      continue;
    }

    if (!tier) {
      markSkip("below_threshold");
      continue;
    }

    if ((tier === "C" && !cfg.allowedTiers.includes("C")) || !overlay.allowedGrades.includes(tier as "A" | "B" | "C")) {
      markSkip("overlay_block");
      continue;
    }

    if (activeSignalIds.has(signalId)) {
      markSkip("already_active_trade");
      continue;
    }
    if (terminalSignalIds.has(signalId)) {
      markSkip("already_terminal_trade");
      continue;
    }
    if (activeSymbolSide.has(`${symbol}:${side}`)) {
      markSkip("already_active_trade");
      continue;
    }

    if (!marketOpen && !allowAfterHoursCreate) {
      markSkip("market_closed");
      continue;
    }

    let shortPenalty = 0;
    if (side === "SHORT") {
      const shortQuality = evaluateShortQuality(s);
      if (!shortQuality.pass) {
        shortSkippedWeakStructure += 1;
        markSkip(shortQuality.blockReason ?? "below_threshold");
        console.log("[seed-from-signals] short_rejected", {
          signalId,
          symbol,
          side,
          rejectReason: shortQuality.reason,
          blockReason: shortQuality.blockReason ?? "below_threshold",
        });
        continue;
      }
      shortQualified += 1;
    }

    // C-tier execution quality gate (v2 performance upgrade)
    // A/B tier signals skip this gate entirely and proceed to execution.
    if (tier === "C") {
      const cGate = evaluateCTierQuality(s, aiScore as number, side, {
        allowCTier: cfg.allowCTier,
        cMinScore: Math.max(cfg.cMinScore, 7.2),
        cMinRelVol: Math.max(cfg.cMinRelVol, 1.5),
        requireTrendAlignment: true,
        cMinRR: Math.max(cfg.cMinRR, 2.0),
      });
      if (!cGate.pass) {
        const blockReason = cGate.blockReason ?? "c_tier_quality_block";
        markSkip(blockReason);
        console.log("[seed-from-signals] c_tier_rejected", {
          signalId,
          symbol,
          side,
          aiScore,
          rejectReason: cGate.debugNote,
          blockReason,
        });
        continue;
      }
    }

    const actionabilityRank = getNum(s, ["actionabilityRank"]) ?? 5;
    allQualifyingCandidates.push({
      symbol,
      side,
      aiScore: aiScore as number,
      entryPrice: normalizedPlan.normalizedEntryPrice,
      stopPrice: normalizedPlan.normalizedStopPrice,
      targetPrice: normalizedPlan.normalizedTargetPrice,
      originalEntryPrice: normalizedPlan.originalEntryPrice,
      originalStopPrice: normalizedPlan.originalStopPrice,
      originalTargetPrice: normalizedPlan.originalTargetPrice,
      normalizedForSide: normalizedPlan.normalizedForSide,
      tier,
      signalId,
      createdAt,
      shortPenalty,
      effectiveScore: (aiScore as number) - shortPenalty,
      actionabilityRank,
      ageMs,
    });
  }

  const { unique: uniqueCandidates, collapsedCount: duplicatesCollapsedCount } = dedupeCandidates(allQualifyingCandidates);
  const selectedKeys = new Set(uniqueCandidates.map(candidateKey));
  for (const c of allQualifyingCandidates) {
    if (selectedKeys.has(candidateKey(c))) continue;
    skipped.push({
      signalId: c.signalId,
      symbol: c.symbol,
      reason: "duplicate_symbol",
      side: c.side,
      originalEntryPrice: c.originalEntryPrice,
      originalStopPrice: c.originalStopPrice,
      originalTargetPrice: c.originalTargetPrice,
      normalizedEntryPrice: c.entryPrice,
      normalizedStopPrice: c.stopPrice,
      normalizedTargetPrice: c.targetPrice,
      normalizedForSide: c.normalizedForSide,
    });
    bumpSkipReason(skippedByReason, "duplicate_symbol");
    attributionBySignalId.set(c.signalId, {
      symbol: c.symbol,
      seedOutcome: "skipped",
      seedReason: "duplicate_symbol",
      linkedTradeId: null,
      createdAt: c.createdAt,
      ageMs: c.ageMs,
      side: c.side,
    });
  }

  const uniqueCandidatesCount = uniqueCandidates.length;
  const totalCandidates = allQualifyingCandidates.length;

  const effectiveCTierGate = {
    cMinScore: Math.max(cfg.cMinScore, 7.2),
    cMinRelVol: Math.max(cfg.cMinRelVol, 1.5),
    requireTrendAlignment: true,
    cMinRR: Math.max(cfg.cMinRR, 2.0),
  };

  const abCandidates = uniqueCandidates.filter((c) => c.tier === "A" || c.tier === "B");
  const cCandidates = uniqueCandidates.filter((c) => c.tier === "C");
  const sortedAbCandidates = [...abCandidates].sort((a, b) => {
    if (b.aiScore !== a.aiScore) return b.aiScore - a.aiScore;
    return b.ageMs - a.ageMs;
  });
  const sortedCCandidates = [...cCandidates].sort((a, b) => {
    if (b.aiScore !== a.aiScore) return b.aiScore - a.aiScore;
    return b.ageMs - a.ageMs;
  });

  const candidatesToSeed =
    sortedAbCandidates.length > 0
      ? sortedAbCandidates.slice(0, effectiveLimit)
      : sortedCCandidates.slice(0, effectiveLimit);

  const capacitySkippedCandidates =
    sortedAbCandidates.length > 0
      ? [...sortedAbCandidates.slice(effectiveLimit), ...sortedCCandidates]
      : sortedCCandidates.slice(effectiveLimit);
  for (const c of capacitySkippedCandidates) {
    skipped.push({
      signalId: c.signalId,
      symbol: c.symbol,
      reason: "capacity_full",
      side: c.side,
      originalEntryPrice: c.originalEntryPrice,
      originalStopPrice: c.originalStopPrice,
      originalTargetPrice: c.originalTargetPrice,
      normalizedEntryPrice: c.entryPrice,
      normalizedStopPrice: c.stopPrice,
      normalizedTargetPrice: c.targetPrice,
      normalizedForSide: c.normalizedForSide,
    });
    bumpSkipReason(skippedByReason, "capacity_full");
    attributionBySignalId.set(c.signalId, {
      symbol: c.symbol,
      seedOutcome: "skipped",
      seedReason: "capacity_full",
      linkedTradeId: null,
      createdAt: c.createdAt,
      ageMs: c.ageMs,
      side: c.side,
    });
  }

  for (const c of candidatesToSeed) {
    const sessionMeta = deriveSessionMeta(nowIso);
    const scoredAt = String(c.createdAt || nowIso);
    const tradeId = crypto.randomUUID();

    const trade = {
      id: tradeId,
      symbol: c.symbol,
      ticker: c.symbol,
      side: c.side,
      entryPrice: c.entryPrice,
      stopPrice: c.stopPrice,
      targetPrice: c.targetPrice,
      takeProfitPrice: c.targetPrice,
      status: "AUTO_PENDING",
      source: "AUTO",
      paper: true,
      createdAt: nowIso,
      updatedAt: nowIso,
      scoredAt,
      etDate: sessionMeta.etDate,
      sessionTag: sessionMeta.sessionTag,
      signalId: c.signalId,
      aiScore: c.aiScore,
      tier: c.tier,
      ai: {
        score: c.aiScore,
        tier: c.tier,
        grade: null,
        riskMult: riskMultForTier(c.tier as AutoTier),
        riskDollars: cfg.baseRiskDollars * riskMultForTier(c.tier as AutoTier),
        qualified: c.aiScore > 0,
        summary: "",
      },
      autoEntryStatus: "AUTO_PENDING",
      seededAt: nowIso,
      executeOutcome: "PENDING",
      executeReason: null as null,
      ...(c.side === "SHORT" && c.shortPenalty > 0 ? { shortPenalty: c.shortPenalty } : {}),
    };

    if (!dryRun) {
      await upsertTrade(trade);
    }

    if (c.side === "LONG") seededLong += 1;
    if (c.side === "SHORT") seededShort += 1;

    created.push({
      id: dryRun ? null : tradeId,
      symbol: c.symbol,
      side: c.side,
      signalId: c.signalId,
      aiScore: c.aiScore,
      effectiveScore: c.effectiveScore,
      tier: c.tier,
      originalEntryPrice: c.originalEntryPrice,
      originalStopPrice: c.originalStopPrice,
      originalTargetPrice: c.originalTargetPrice,
      normalizedEntryPrice: c.entryPrice,
      normalizedStopPrice: c.stopPrice,
      normalizedTargetPrice: c.targetPrice,
      normalizedForSide: c.normalizedForSide,
      dryRun,
    });

    attributionBySignalId.set(c.signalId, {
      symbol: c.symbol,
      seedOutcome: "created",
      seedReason: dryRun ? "created_dry_run" : "created",
      linkedTradeId: dryRun ? null : tradeId,
      createdAt: c.createdAt,
      ageMs: c.ageMs,
      side: c.side,
    });
  }

  const seedEvaluatedAt = new Date().toISOString();
  let updatedSignalsCount = 0;
  const updatedSignals: StoredSignal[] = (allStoredSignals || []).map((sig) => {
    const sid = String((sig as any)?.id || "");
    const a = attributionBySignalId.get(sid);
    if (!a) return sig;
    updatedSignalsCount += 1;
    return {
      ...sig,
      seedEvaluatedAt,
      seedOutcome: a.seedOutcome,
      seedReason: a.seedReason,
      linkedTradeId: a.linkedTradeId,
      updatedAt: seedEvaluatedAt,
    };
  });
  if (updatedSignalsCount > 0) {
    await writeSignals(updatedSignals);
  }

  const duplicateSkippedCount = skippedByReason.duplicate_symbol ?? 0;
  const alreadyHasTradeSkippedCount = (skippedByReason.already_active_trade ?? 0) + (skippedByReason.already_terminal_trade ?? 0);
  const limitReachedSkippedCount = skippedByReason.capacity_full ?? 0;
  const belowMinScoreSkippedCount = skippedByReason.below_threshold ?? 0;
  const missingDirectionSkippedCount = skippedByReason.missing_direction ?? 0;
  const missingPricesSkippedCount = skippedByReason.missing_prices ?? 0;
  const overlayGradeSkippedCount = skippedByReason.overlay_block ?? 0;
  const cTierQualityBlockCount =
    (skippedByReason.c_tier_quality_block ?? 0) +
    (skippedByReason.flat_trend_block ?? 0) +
    (skippedByReason.weak_volume_block ?? 0) +
    (skippedByReason.vwap_alignment_block ?? 0) +
    (skippedByReason.poor_rr_block ?? 0);

  await bumpTodayFunnel({
    seedFromQualifiedLong: seededLong,
    seedFromQualifiedShort: seededShort,
    seedTotalCandidates: totalCandidates,
    seedCreatedCount: dryRun ? 0 : created.length,
    seedUniqueCandidates: uniqueCandidatesCount,
    seedDuplicatesCollapsed: duplicatesCollapsedCount,
    shortQualified,
    shortSeeded: seededShort,
    shortSkippedWeakStructure,
    seedSkippedNotQualified: notQualifiedSkippedCount,
    seedSkippedOverlayGrade: overlayGradeSkippedCount,
    seedSkippedMissingSymbol: 0,
    seedSkippedAlreadyHasTrade: alreadyHasTradeSkippedCount,
    seedSkippedDuplicate: duplicateSkippedCount,
    seedSkippedLimitReached: limitReachedSkippedCount,
    seedSkippedBelowMinScore: belowMinScoreSkippedCount,
    seedSkippedMissingDirection: missingDirectionSkippedCount,
    seedSkippedMissingPrices: missingPricesSkippedCount,
    seedSkippedTierDisabled: 0,
    seedSkippedCTierQualityBlock: cTierQualityBlockCount,
    seedSkippedOther: (skippedByReason.market_closed ?? 0) + (skippedByReason.stale_signal ?? 0),
  });

  const skippedQualifiedSignals = Array.from(attributionBySignalId.entries())
    .map(([signalId, a]) => {
      const mapped = mapSkipReason(a.seedReason);
      if (a.seedOutcome !== "skipped" || !mapped) return null;
      return {
        signalId,
        symbol: a.symbol,
        reason: mapped,
        ageMs: typeof a.ageMs === "number" && Number.isFinite(a.ageMs) ? a.ageMs : null,
      };
    })
    .filter(Boolean) as SeedRunTelemetry["skippedQualifiedSignals"];

  let funnelBlockIncident: { created: boolean; incidentId: string } | null = null;
  const createdCount = dryRun ? 0 : created.length;

  // Distinguish QUALITY_FILTERING (intentional gates) from TRUE_EXECUTION_BLOCK (system broken)
  // Only raise CRITICAL incident when ALL skips are NOT quality gates — meaning a real system issue.
  const qualityFilteredAllSkips =
    freshQualifiedSignals > 0 &&
    createdCount === 0 &&
    cTierQualityBlockCount + (skippedByReason.below_threshold ?? 0) >= freshQualifiedSignals;

  const shouldRaiseFunnelBlock =
    marketOpen && freshQualifiedSignals > 0 && createdCount === 0 && !qualityFilteredAllSkips;

  if (shouldRaiseFunnelBlock) {
    const skipDetails = skippedQualifiedSignals.slice(0, 25).map((s) =>
      `${s.symbol}:${s.signalId}:${s.reason}${s.ageMs != null ? `:${s.ageMs}ms` : ""}`
    );
    const result = await upsertIncident({
      severity: "CRITICAL",
      source: "ops",
      category: "FUNNEL_BLOCK",
      title: "Fresh qualified signals not seeded",
      summary: `marketOpen=true freshQualifiedSignals=${freshQualifiedSignals} createdCount=${createdCount} staleQualifiedSignals=${staleQualifiedSignals} incidentType=TRUE_EXECUTION_BLOCK`,
      notes: [
        `runId=${runId}`,
        `source=${runSource}`,
        `skipReasonCounts=${JSON.stringify(skippedByReason)}`,
        `skippedQualifiedSignals=${JSON.stringify(skipDetails)}`,
        `recommendedAction=Check seed route auth, capacity, and overlay config. A/B-tier signals should not be blocked.`,
      ],
    });
    funnelBlockIncident = { created: result.created, incidentId: result.incident.id };
  } else if (qualityFilteredAllSkips) {
    // Quality filtering is working as intended — resolve any stale FUNNEL_BLOCK incident
    await resolveIncident(
      { category: "FUNNEL_BLOCK", title: "Fresh qualified signals not seeded" },
      `Quality filtering active: cTierQualityBlockCount=${cTierQualityBlockCount} qualifiedSignals=${freshQualifiedSignals} — no true execution block detected.`,
    );
  } else {
    await resolveIncident(
      { category: "FUNNEL_BLOCK", title: "Fresh qualified signals not seeded" },
      `Recovered: marketOpen=${marketOpen} freshQualifiedSignals=${freshQualifiedSignals} createdCount=${createdCount}`,
    );
  }

  const telemetryPayload: SeedRunTelemetry = {
    runAt: seedEvaluatedAt,
    source: runSource,
    marketOpen,
    totalQualifiedSignals: qualifiedSignals.length,
    freshQualifiedSignals,
    staleQualifiedSignals,
    totalCandidates,
    createdCount,
    staleThresholdUsedMs,
    skippedByReason,
    skippedQualifiedSignals,
    dryRun,
    debug,
    runId,
  };
  await recordSeedRunTelemetry(today, telemetryPayload);

  console.log("[seed-from-signals] complete", {
    runId,
    source: runSource,
    dryRun,
    debug,
    marketOpen,
    seededCount: createdCount,
    totalQualifiedSignals: qualifiedSignals.length,
    freshQualifiedSignals,
    staleQualifiedSignals,
    candidates: totalCandidates,
    skipReasonCounts: skippedByReason,
    effectiveLimit,
    openPositions: currentOpenPositions,
    entriesToday,
    limitReason,
    staleThresholdUsedMs,
    freshnessMode,
  });

  const freshAgeMsValues = qualifiedSignalAges.map(a => a.ageMs).filter(Number.isFinite);
  const newestQualifiedAgeMs = freshAgeMsValues.length > 0 ? Math.min(...freshAgeMsValues) : null;
  const oldestQualifiedAgeMs = freshAgeMsValues.length > 0 ? Math.max(...freshAgeMsValues) : null;

  return NextResponse.json({
    ok: true,
    today,
    runId,
    runAt: seedEvaluatedAt,
    source: runSource,
    marketOpen,
    dryRun,
    debug,
    requestedLimit,
    effectiveLimit,
    limitReason,
    currentOpenPositions,
    maxOpenPositions,
    remainingPositionSlots,
    entriesToday,
    maxEntriesPerDay,
    remainingEntriesToday,
    minScore,
    effectiveMinScore,
    staleThresholdUsedMs,
    freshnessMode,
    newestQualifiedAgeMs,
    oldestQualifiedAgeMs,
    totalSignals: (signals || []).length,
    totalQualifiedSignals: qualifiedSignals.length,
    freshQualifiedSignals,
    staleQualifiedSignals,
    signalsFilteredOutByEtDay: signalsFilteredOut,
    rawSignalsFromApi: (rawSignals || []).length,
    etDayBounds: { startMs: dayStartMs, endMs: dayEndMs },
    totalCandidates,
    uniqueCandidatesCount,
    duplicatesCollapsedCount,
    seededCount: dryRun ? 0 : created.length,
    createdCount: dryRun ? 0 : created.length,
    skippedCount: skipped.length,
    seededLong,
    seededShort,
    shortQualified,
    shortSkippedWeakStructure,
    skipReasonCounts: skippedByReason,
    // C-tier quality gate debug counts
    cTierQualityBlockCount,
    cTierQualityGateConfig: {
      allowCTier: cfg.allowCTier,
      cMinScore: effectiveCTierGate.cMinScore,
      cMinRelVol: effectiveCTierGate.cMinRelVol,
      requireTrendAlignment: effectiveCTierGate.requireTrendAlignment,
      cMinRR: effectiveCTierGate.cMinRR,
    },
    // Funnel intent classification
    funnelIntent: qualityFilteredAllSkips
      ? "QUALITY_FILTERING"
      : createdCount > 0
      ? "SEEDED"
      : freshQualifiedSignals === 0
      ? "NO_FRESH_SIGNALS"
      : "SYSTEM_ISSUE",
    skippedQualifiedSignals: skippedQualifiedSignals.slice(0, 250),
    qualifiedSignalAges: qualifiedSignalAges.slice(0, 250),
    perSignalAgeMs: qualifiedSignalAges.slice(0, 250),
    attributedQualifiedSignals: updatedSignalsCount,
    funnelBlockIncident,
    eligibilityAudit: {
      staleThresholdUsedMs,
      etDayFiltering: {
        startMs: dayStartMs,
        endMs: dayEndMs,
      },
      statusRequirement: "qualified_true_and_not_archived",
      shownInAppRequired: false,
      directionRequired: true,
      pricePlanRequired: true,
        qualifiedPrimaryEligibility: true,
        minScoreProvided,
      minScoreUsed: effectiveMinScore,
    },
    created,
    skipped: skipped.slice(0, 100),
    brokerTruthError: brokerTruth.error ?? null,
    overlay: {
      posture: overlay.posture,
      allowedGrades: overlay.allowedGrades,
      minScoreAdjustment: overlay.minScoreAdjustment,
      maxEntriesOverride: overlay.maxEntriesOverride,
      stateAvailable: overlay.stateAvailable,
    },
  }, { status: 200 });
}
