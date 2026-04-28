import { NextRequest, NextResponse } from "next/server";
import { readTrades, upsertTrade } from "@/lib/tradesStore";
import { getAutoConfig, tierForScore } from "@/lib/autoEntry/config";
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
  penalty: number;
};

/**
 * Lightweight short-side quality check.
 * Uses existing signal fields only - does NOT block, just penalizes score.
 */
function evaluateShortQuality(signal: RawSignal): ShortQualityResult {
  let penalty = 0;
  const reasons: string[] = [];

  // 1. Trend check: prefer "down" trend for shorts
  const trend = getStr(signal, ["trend", "ai.trend", "context.trend"]);
  if (trend) {
    const trendLower = trend.toLowerCase();
    if (trendLower === "flat" || trendLower === "neutral") {
      penalty += 5;
      reasons.push("flat_trend");
    } else if (trendLower === "up" || trendLower === "bullish") {
      penalty += 10;
      reasons.push("bullish_trend");
    }
    // "down" or "bearish" = no penalty
  }

  // 2. VWAP alignment: shorts should prefer at/below VWAP or rejection above
  const vwapPosition = getStr(signal, ["vwapPosition", "ai.vwapPosition", "context.vwapPosition"]);
  const price = getNum(signal, ["entryPrice", "price", "lastPrice"]);
  const vwap = getNum(signal, ["vwap", "context.vwap"]);
  
  if (vwapPosition) {
    const vpLower = vwapPosition.toLowerCase();
    if (vpLower === "above" || vpLower.includes("above")) {
      // Above VWAP short - slightly risky
      penalty += 3;
      reasons.push("above_vwap");
    }
  } else if (price && vwap && vwap > 0) {
    const distPct = ((price - vwap) / vwap) * 100;
    if (distPct > 1.0) {
      // More than 1% above VWAP
      penalty += 3;
      reasons.push("above_vwap_calc");
    }
  }

  // 3. Relative volume check: shorts need decent volume
  const relVol = getNum(signal, ["relVol", "relativeVolume", "context.relVol"]);
  if (relVol != null && relVol < 1.2) {
    // Below 1.2x relative volume - weak liquidity for short
    penalty += 5;
    reasons.push("low_relvol");
  }

  // Threshold: if penalty >= 15, soft reject (but don't hard block)
  const pass = penalty < 15;
  return {
    pass,
    penalty,
    reason: reasons.length > 0 ? reasons.join(",") : null,
  };
}

// -------------------------------------------------------------------------
// Phase 3c: Candidate Deduplication & Ranking
// -------------------------------------------------------------------------

type QualifiedCandidate = {
  signal: RawSignal;
  symbol: string;
  side: "LONG" | "SHORT";
  aiScore: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
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

  // Final sort: primary by effectiveScore; within 0.3 points, prefer higher actionabilityRank
  unique.sort((a, b) => {
    const scoreDiff = b.effectiveScore - a.effectiveScore;
    if (Math.abs(scoreDiff) > 0.3) return scoreDiff;
    return b.actionabilityRank - a.actionabilityRank;
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
  const maxSignalAgeMin = Number.isFinite(Number(process.env.AUTO_ENTRY_SEED_MAX_AGE_MIN))
    ? Math.max(1, Number(process.env.AUTO_ENTRY_SEED_MAX_AGE_MIN))
    : 30;
  const staleThresholdUsedMs = Math.round(maxSignalAgeMin * 60 * 1000);

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
  const skipped: Array<{ signalId: string; symbol: string; reason: string }> = [];
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

    const markSkip = (reason: SeedSkipReason) => {
      skipped.push({ signalId, symbol, reason });
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
      shortPenalty = shortQuality.penalty;
      if (!shortQuality.pass) {
        shortSkippedWeakStructure += 1;
        markSkip("below_threshold");
        continue;
      }
      shortQualified += 1;
    }

    const actionabilityRank = getNum(s, ["actionabilityRank"]) ?? 5;
    allQualifyingCandidates.push({
      signal: s,
      symbol,
      side,
      aiScore: aiScore as number,
      entryPrice: entryPrice as number,
      stopPrice: stopPrice as number,
      targetPrice: targetPrice as number,
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
    skipped.push({ signalId: c.signalId, symbol: c.symbol, reason: "duplicate_symbol" });
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

  const candidatesToSeed = uniqueCandidates.slice(0, effectiveLimit);
  const capacitySkippedCandidates = uniqueCandidates.slice(effectiveLimit);
  for (const c of capacitySkippedCandidates) {
    skipped.push({ signalId: c.signalId, symbol: c.symbol, reason: "capacity_full" });
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
    const scoredAt = String(c.signal?.scoredAt || c.signal?.updatedAt || c.createdAt || nowIso);
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
        grade: null as string | null,
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
  const shouldRaiseFunnelBlock = marketOpen && freshQualifiedSignals > 0 && createdCount === 0;
  if (shouldRaiseFunnelBlock) {
    const skipDetails = skippedQualifiedSignals.slice(0, 25).map((s) =>
      `${s.symbol}:${s.signalId}:${s.reason}${s.ageMs != null ? `:${s.ageMs}ms` : ""}`
    );
    const result = await upsertIncident({
      severity: "CRITICAL",
      source: "ops",
      category: "FUNNEL_BLOCK",
      title: "Fresh qualified signals not seeded",
      summary: `marketOpen=true freshQualifiedSignals=${freshQualifiedSignals} createdCount=${createdCount} staleQualifiedSignals=${staleQualifiedSignals}`,
      notes: [
        `runId=${runId}`,
        `source=${runSource}`,
        `skipReasonCounts=${JSON.stringify(skippedByReason)}`,
        `skippedQualifiedSignals=${JSON.stringify(skipDetails)}`,
      ],
    });
    funnelBlockIncident = { created: result.created, incidentId: result.incident.id };
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
  });

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
