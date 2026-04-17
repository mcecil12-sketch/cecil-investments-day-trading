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

function parseSignalsPayload(payload: any): RawSignal[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.signals)) return payload.signals;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
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
      // Tie-breaker: newest signal first
      const aTime = new Date(a.createdAt).getTime() || 0;
      const bTime = new Date(b.createdAt).getTime() || 0;
      return bTime - aTime;
    });

    // Keep only the best
    unique.push(group[0]);
    collapsedCount += group.length - 1;
  }

  // Final sort by effectiveScore DESC for consistent ordering
  unique.sort((a, b) => b.effectiveScore - a.effectiveScore);

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

  // Parse params from both URL query params AND JSON body for flexibility
  const url = new URL(req.url);
  const limitRawQuery = url.searchParams.get("limit");
  const minScoreRawQuery = url.searchParams.get("minScore");

  // Also try to read from JSON body (workflow sends params in body)
  let bodyLimit: number | undefined;
  let bodyMinScore: number | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    if (body && typeof body === "object") {
      if (typeof body.limit === "number" && Number.isFinite(body.limit)) bodyLimit = body.limit;
      if (typeof body.minScore === "number" && Number.isFinite(body.minScore)) bodyMinScore = body.minScore;
    }
  } catch {
    // Ignore parse errors
  }

  // Priority: query param > body > default
  const limitParsed = Number(limitRawQuery) || bodyLimit;
  const minScoreParsed = Number(minScoreRawQuery) || bodyMinScore;

  // Apply defaults and bounds - DEFAULT IS NOW 3 (capacity-aware, not throttled to 1)
  const requestedLimit = (typeof limitParsed === "number" && Number.isFinite(limitParsed))
    ? Math.max(1, Math.min(50, limitParsed))
    : 3; // Default changed from 1 to 3 for capacity-aware seeding

  const minScore = (typeof minScoreParsed === "number" && Number.isFinite(minScoreParsed))
    ? minScoreParsed
    : 0;

  const today = getEtDateString();
  const { startMs: dayStartMs, endMs: dayEndMs } = getEtDayBoundsMs(today);

  // Fetch guardrails config for capacity calculations
  const guardConfig = getGuardrailConfig();

  // Parallel fetch: signals, trades, overlay, broker truth, guardrails state
  const [rawSignals, trades, overlay, brokerTruth, guardState] = await Promise.all([
    fetchScoredSignalsFromInternalApi(),
    readTrades<any>(),
    readExecutionOverlays(),
    fetchBrokerTruth(),
    getGuardrailsState(today),
  ]);

  // -------------------------------------------------------------------------
  // ET-TODAY SIGNAL FILTERING
  // Filter to only today's signals for consistent funnel attribution
  // -------------------------------------------------------------------------
  const signals = (rawSignals || []).filter((s: RawSignal) => {
    const createdAt = s?.createdAt;
    if (createdAt == null) return false;
    const tsMs = typeof createdAt === "number" ? createdAt : Date.parse(createdAt);
    if (!Number.isFinite(tsMs)) return false;
    return tsMs >= dayStartMs && tsMs < dayEndMs;
  });

  const signalsFilteredOut = (rawSignals || []).length - signals.length;

  // -------------------------------------------------------------------------
  // CAPACITY-AWARE LIMIT CALCULATION
  // -------------------------------------------------------------------------
  // Compute remaining capacity from broker truth and guardrails state
  const currentOpenPositions = brokerTruth.positionsCount ?? 0;
  const maxOpenPositions = guardConfig.maxOpenPositions;
  const entriesToday = guardState.entriesToday ?? 0;
  const maxEntriesPerDay = guardConfig.maxEntriesPerDay;

  const remainingPositionSlots = Math.max(0, maxOpenPositions - currentOpenPositions);
  const remainingEntriesToday = Math.max(0, maxEntriesPerDay - entriesToday);

  // Determine the tightest constraint for limit calculation
  let effectiveLimit = requestedLimit;
  let limitReason = "requested_limit";

  // Apply overlay maxEntriesOverride if set
  if (overlay.maxEntriesOverride != null && overlay.maxEntriesOverride >= 0) {
    if (overlay.maxEntriesOverride < effectiveLimit) {
      effectiveLimit = overlay.maxEntriesOverride;
      limitReason = "overlay_max_entries_override";
    }
  }

  // Apply position capacity constraint
  if (remainingPositionSlots < effectiveLimit) {
    effectiveLimit = remainingPositionSlots;
    limitReason = remainingPositionSlots === 0 ? "no_position_capacity" : "position_capacity";
  }

  // Apply entries/day constraint
  if (remainingEntriesToday < effectiveLimit) {
    effectiveLimit = remainingEntriesToday;
    limitReason = remainingEntriesToday === 0 ? "entries_per_day_exhausted" : "entries_per_day";
  }

  // Ensure non-negative
  effectiveLimit = Math.max(0, effectiveLimit);

  // If no capacity, return early with success (no error)
  if (effectiveLimit === 0) {
    console.log("[seed-from-signals] no capacity available", {
      requestedLimit,
      effectiveLimit,
      limitReason,
      currentOpenPositions,
      maxOpenPositions,
      remainingPositionSlots,
      entriesToday,
      maxEntriesPerDay,
      remainingEntriesToday,
    });

    return NextResponse.json({
      ok: true,
      today,
      // Core limits and capacity (top-level for easy access)
      requestedLimit,
      effectiveLimit: 0,
      limitReason,
      currentOpenPositions,
      maxOpenPositions,
      remainingPositionSlots,
      entriesToday,
      maxEntriesPerDay,
      remainingEntriesToday,
      // Scoring threshold
      minScore,
      // Signal and candidate counts
      totalSignals: (signals || []).length,
      totalCandidates: 0,
      // Seeding results
      seededCount: 0,
      createdCount: 0,
      skippedCount: 0,
      // Broker truth status
      brokerTruthError: brokerTruth.error ?? null,
      created: [],
      skipped: [],
    }, { status: 200 });
  }

  console.log("[seed-from-signals] capacity check", {
    requestedLimit,
    effectiveLimit,
    limitReason,
    currentOpenPositions,
    maxOpenPositions,
    remainingPositionSlots,
    entriesToday,
    maxEntriesPerDay,
    remainingEntriesToday,
  });

  const existingBySignalId = new Set<string>();
  const existingPendingBySymbolSide = new Set<string>();

  for (const t of trades || []) {
    const sid = String(t?.signalId || "");
    if (sid) existingBySignalId.add(sid);

    const status = String(t?.status || "").toUpperCase();
    const symbol = String(t?.ticker || t?.symbol || "").toUpperCase();
    const side = normalizeDirection(t?.side);
    if (status === "AUTO_PENDING" && symbol && side) {
      existingPendingBySymbolSide.add(`${symbol}:${side}`);
    }
  }

  // -------------------------------------------------------------------------
  // PHASE 3c: Two-Pass Candidate Processing with Deduplication
  // -------------------------------------------------------------------------
  // Pass 1: Collect all qualifying candidates (no limit yet)
  // Pass 2: Dedupe by symbol+side, keeping best per group
  // Pass 3: Apply limit AFTER deduplication
  // -------------------------------------------------------------------------

  const created: any[] = [];
  const skipped: any[] = [];
  const skipReasonCounts: Record<string, number> = {};
  
  // Phase 3c: Track short quality metrics
  let shortQualified = 0;
  let shortSkippedWeakStructure = 0;
  let seededLong = 0;
  let seededShort = 0;

  const effectiveMinScore = minScore + overlay.minScoreAdjustment;
  const allQualifyingCandidates: QualifiedCandidate[] = [];

  // PASS 1: Collect all qualifying candidates
  for (const s of signals || []) {
    const status = String(s?.status || "").toUpperCase();
    if (status !== "SCORED") continue;
    
    if (s?.qualified !== true) {
      skipped.push({ symbol: getSymbol(s) || "UNKNOWN", reason: "not_qualified" });
      continue;
    }

    const symbol = getSymbol(s);
    if (!symbol) {
      skipped.push({ symbol: "UNKNOWN", reason: "missing_symbol" });
      continue;
    }

    const side = getDirection(s);
    if (!side) {
      skipped.push({ symbol, reason: "missing_direction" });
      continue;
    }

    const aiScore = getNum(s, ["aiScore", "score"]);
    if (aiScore == null || aiScore < effectiveMinScore) {
      skipped.push({
        symbol,
        reason: overlay.minScoreAdjustment !== 0 ? "below_overlay_adjusted_minScore" : "below_minScore",
      });
      continue;
    }

    const entryPrice = getNum(s, ["entryPrice", "ai.entryPrice"]);
    const stopPrice = getNum(s, ["stopPrice", "ai.stopPrice"]);
    const targetPrice = getNum(s, ["targetPrice", "takeProfitPrice", "ai.targetPrice", "ai.takeProfitPrice"]);

    if (entryPrice == null || stopPrice == null || targetPrice == null) {
      skipped.push({ symbol, reason: "missing_required_prices" });
      continue;
    }

    const tier = tierForScore(aiScore) || "C";
    if (tier === "C" && !cfg.allowedTiers.includes("C")) {
      skipped.push({ symbol, reason: "tier_c_disabled" });
      continue;
    }

    if (!overlay.allowedGrades.includes(tier as "A" | "B" | "C")) {
      skipped.push({ symbol, reason: "overlay_grade_excluded", grade: tier, allowedGrades: overlay.allowedGrades });
      continue;
    }

    const signalId = String(s.id || "");

    // Check for existing trades
    if (signalId && existingBySignalId.has(signalId)) {
      skipped.push({ symbol, reason: "already_has_trade_for_signal" });
      continue;
    }

    const symbolSide = `${symbol}:${side}`;
    if (existingPendingBySymbolSide.has(symbolSide)) {
      skipped.push({ symbol, reason: "already_has_pending_for_symbol_side" });
      continue;
    }

    // Phase 3c: Short-side quality check
    let shortPenalty = 0;
    if (side === "SHORT") {
      const shortQuality = evaluateShortQuality(s);
      shortPenalty = shortQuality.penalty;
      
      if (!shortQuality.pass) {
        shortSkippedWeakStructure += 1;
        skipped.push({ 
          symbol, 
          reason: "short_weak_structure", 
          penalty: shortPenalty,
          detail: shortQuality.reason 
        });
        continue;
      }
      shortQualified += 1;
    }

    // Calculate effective score (aiScore - shortPenalty for shorts)
    const effectiveScore = aiScore - shortPenalty;

    const createdAt = String(s?.createdAt || s?.updatedAt || new Date().toISOString());

    allQualifyingCandidates.push({
      signal: s,
      symbol,
      side,
      aiScore,
      entryPrice,
      stopPrice,
      targetPrice,
      tier,
      signalId,
      createdAt,
      shortPenalty,
      effectiveScore,
    });
  }

  // PASS 2: Deduplicate by symbol+side
  const { unique: uniqueCandidates, collapsedCount: duplicatesCollapsedCount } = dedupeCandidates(allQualifyingCandidates);
  const totalCandidates = allQualifyingCandidates.length;
  const uniqueCandidatesCount = uniqueCandidates.length;

  // Track collapsed duplicates as skipped
  if (duplicatesCollapsedCount > 0) {
    skipped.push(...Array(duplicatesCollapsedCount).fill({ symbol: "COLLAPSED", reason: "duplicate_collapsed_in_dedupe" }));
  }

  // PASS 3: Apply limit AFTER deduplication and create trades
  const candidatesToSeed = uniqueCandidates.slice(0, effectiveLimit);
  const limitSkippedCandidates = uniqueCandidates.slice(effectiveLimit);

  // Track limit-reached skips
  for (const c of limitSkippedCandidates) {
    skipped.push({ symbol: c.symbol, reason: "limit_reached" });
  }

  // Create trades for selected candidates
  for (const c of candidatesToSeed) {
    const now = new Date().toISOString();
    const sessionMeta = deriveSessionMeta(now);
    const scoredAt = String(c.signal?.scoredAt || c.signal?.updatedAt || c.createdAt || now);

    const trade = {
      id: crypto.randomUUID(),
      ticker: c.symbol,
      side: c.side,
      entryPrice: c.entryPrice,
      stopPrice: c.stopPrice,
      targetPrice: c.targetPrice,
      takeProfitPrice: c.targetPrice,
      status: "AUTO_PENDING",
      source: "AUTO",
      paper: true,
      createdAt: now,
      updatedAt: now,
      scoredAt,
      etDate: sessionMeta.etDate,
      sessionTag: sessionMeta.sessionTag,
      signalId: c.signalId,
      aiScore: c.aiScore,
      tier: c.tier,
      autoEntryStatus: "AUTO_PENDING",
      // Phase 3c: Track short penalty for debugging
      ...(c.side === "SHORT" && c.shortPenalty > 0 ? { shortPenalty: c.shortPenalty } : {}),
    };

    await upsertTrade(trade);

    existingBySignalId.add(c.signalId);
    existingPendingBySymbolSide.add(`${c.symbol}:${c.side}`);

    if (c.side === "LONG") seededLong += 1;
    if (c.side === "SHORT") seededShort += 1;

    created.push({
      id: trade.id,
      symbol: c.symbol,
      side: c.side,
      signalId: c.signalId,
      aiScore: c.aiScore,
      effectiveScore: c.effectiveScore,
      tier: c.tier,
    });
  }

  // Aggregate skip reasons
  for (const s of skipped) {
    const reason = s.reason || "unknown";
    skipReasonCounts[reason] = (skipReasonCounts[reason] ?? 0) + 1;
  }

  // Compute explicit skip counts
  const duplicateSkippedCount = (skipReasonCounts["duplicate_collapsed_in_dedupe"] ?? 0);
  const alreadyHasTradeSkippedCount = (skipReasonCounts["already_has_trade_for_signal"] ?? 0) + 
                                      (skipReasonCounts["already_has_pending_for_symbol_side"] ?? 0);
  const limitReachedSkippedCount = (skipReasonCounts["limit_reached"] ?? 0);
  const notQualifiedSkippedCount = (skipReasonCounts["not_qualified"] ?? 0);
  const belowMinScoreSkippedCount = (skipReasonCounts["below_minScore"] ?? 0) + 
                                    (skipReasonCounts["below_overlay_adjusted_minScore"] ?? 0);
  const missingDirectionSkippedCount = (skipReasonCounts["missing_direction"] ?? 0);
  const missingPricesSkippedCount = (skipReasonCounts["missing_required_prices"] ?? 0);
  const tierDisabledSkippedCount = (skipReasonCounts["tier_c_disabled"] ?? 0);
  const overlayGradeSkippedCount = (skipReasonCounts["overlay_grade_excluded"] ?? 0);
  const shortWeakStructureSkippedCount = (skipReasonCounts["short_weak_structure"] ?? 0);

  // Bump funnel counters
  await bumpTodayFunnel({
    seedFromQualifiedLong: seededLong,
    seedFromQualifiedShort: seededShort,
    seedTotalCandidates: totalCandidates,
    seedCreatedCount: created.length,
    // Phase 3c: Deduplication visibility
    seedUniqueCandidates: uniqueCandidatesCount,
    seedDuplicatesCollapsed: duplicatesCollapsedCount,
    // Phase 3c: Short quality
    shortQualified: shortQualified,
    shortSeeded: seededShort,
    shortSkippedWeakStructure: shortSkippedWeakStructure,
    // Skip reasons
    seedSkippedNotQualified: notQualifiedSkippedCount,
    seedSkippedOverlayGrade: overlayGradeSkippedCount,
    seedSkippedMissingSymbol: skipReasonCounts["missing_symbol"] ?? 0,
    seedSkippedAlreadyHasTrade: alreadyHasTradeSkippedCount,
    seedSkippedDuplicate: duplicateSkippedCount,
    seedSkippedLimitReached: limitReachedSkippedCount,
    seedSkippedBelowMinScore: belowMinScoreSkippedCount,
    seedSkippedMissingDirection: missingDirectionSkippedCount,
    seedSkippedMissingPrices: missingPricesSkippedCount,
    seedSkippedTierDisabled: tierDisabledSkippedCount,
    seedSkippedOther: Math.max(0, skipped.length - (
      notQualifiedSkippedCount +
      overlayGradeSkippedCount +
      (skipReasonCounts["missing_symbol"] ?? 0) +
      alreadyHasTradeSkippedCount +
      duplicateSkippedCount +
      limitReachedSkippedCount +
      belowMinScoreSkippedCount +
      missingDirectionSkippedCount +
      missingPricesSkippedCount +
      tierDisabledSkippedCount +
      shortWeakStructureSkippedCount
    )),
  });

  // Lightweight summary log
  console.log("[seed-from-signals] complete", {
    seededCount: created.length,
    candidates: totalCandidates,
    effectiveLimit,
    openPositions: currentOpenPositions,
    entriesToday,
    limitReason,
  });

  return NextResponse.json(
    {
      ok: true,
      today,
      // Core limits and capacity (top-level for easy access)
      requestedLimit,
      effectiveLimit,
      limitReason,
      currentOpenPositions,
      maxOpenPositions,
      remainingPositionSlots,
      entriesToday,
      maxEntriesPerDay,
      remainingEntriesToday,
      // Scoring threshold
      minScore,
      // Signal and candidate counts
      totalSignals: (signals || []).length,
      signalsFilteredOutByEtDay: signalsFilteredOut,
      rawSignalsFromApi: (rawSignals || []).length,
      etDayBounds: { startMs: dayStartMs, endMs: dayEndMs },
      totalCandidates,
      uniqueCandidatesCount,
      duplicatesCollapsedCount,
      // Seeding results (seededCount = alias for createdCount)
      seededCount: created.length,
      createdCount: created.length,
      skippedCount: skipped.length,
      skippedByOverlayCount: skipped.filter((s) => s.reason === "overlay_grade_excluded" || s.reason === "below_overlay_adjusted_minScore").length,
      // Direction breakdown
      seededLong,
      seededShort,
      // Phase 3c: Short-side metrics
      shortQualified,
      shortSkippedWeakStructure,
      // Explicit skip counts
      duplicateSkippedCount,
      alreadyHasTradeSkippedCount,
      limitReachedSkippedCount,
      notQualifiedSkippedCount,
      belowMinScoreSkippedCount,
      missingDirectionSkippedCount,
      missingPricesSkippedCount,
      tierDisabledSkippedCount,
      overlayGradeSkippedCount,
      shortWeakStructureSkippedCount,
      skipReasonCounts,
      created,
      skipped: skipped.slice(0, 50),
      // Broker truth status
      brokerTruthError: brokerTruth.error ?? null,
      overlay: {
        posture: overlay.posture,
        allowedGrades: overlay.allowedGrades,
        minScoreAdjustment: overlay.minScoreAdjustment,
        maxEntriesOverride: overlay.maxEntriesOverride,
        stateAvailable: overlay.stateAvailable,
      },
    },
    { status: 200 }
  );
}
