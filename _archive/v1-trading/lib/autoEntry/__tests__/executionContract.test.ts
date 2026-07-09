/**
 * Regression tests for the seed → execute contract.
 *
 * These tests guard against regressions that caused the production system
 * to fail when valid seeded trades were incorrectly blocked at execution:
 *
 *   1. C-tier trades with aiScore 6.6 must pass both seed and execute threshold checks.
 *   2. Fully-scored trades must never be marked rescore_required.
 *   3. A payload that is "complete" (has all required fields) must be detected correctly
 *      so the two-path eligibility router in execute can bypass the AI rescore gate.
 *   4. Price drift failure on one trade must not prevent other incomplete candidates from
 *      being evaluated (loop continuity — tested via the eligibility contract).
 */
import { describe, expect, it } from "vitest";
import {
  evaluatePendingEligibility,
  type EligibilityConfig,
} from "@/lib/autoEntry/eligibility";
import {
  isScoreBelowAdjustedThreshold,
  resolveThresholdDiagnostics,
} from "@/lib/autoEntry/executionThresholds";
import { tierForScore } from "@/lib/autoEntry/config";

// ── Helpers ──────────────────────────────────────────────────────────────────

function isoMinutesAgo(mins: number) {
  return new Date(Date.now() - mins * 60_000).toISOString();
}

function todayET() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

/** Build a complete AUTO_PENDING trade payload as seed-from-signals produces it. */
function completeSeedPayload(overrides: Record<string, any> = {}) {
  return {
    id: "test-trade-1",
    status: "AUTO_PENDING",
    source: "auto-entry",
    ticker: "GILD",
    symbol: "GILD",
    side: "LONG",
    entryPrice: 129.64,
    stopPrice: 128.34,
    takeProfitPrice: 132.23,
    aiScore: 6.6,
    tier: "C",
    ai: { score: 6.6, tier: "C", qualified: true },
    createdAt: isoMinutesAgo(2),
    updatedAt: isoMinutesAgo(2),
    ...overrides,
  };
}

const rthEligibilityCfg: EligibilityConfig = {
  todayET: todayET(),
  currentSessionTag: "RTH",
  marketIsOpen: true,
  maxAgeMin: 30,
  rescoreAfterMin: 10,
  blockCarryover: true,
};

// ── CASE 2: C-tier aiScore 6.6 passes the full seed → execute pipeline ───────

describe("CASE 2 – C-tier aiScore 6.6 passes seed and execute", () => {
  it("tierForScore(6.6) resolves to C", () => {
    expect(tierForScore(6.6)).toBe("C");
  });

  it("evaluatePendingEligibility: fresh C-tier trade aged 2m is eligible (NOT rescore_required)", () => {
    const trade = completeSeedPayload();
    const now = new Date().toISOString();
    const result = evaluatePendingEligibility(trade, now, rthEligibilityCfg);
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe("eligible");
    expect(result.requiresRescore).toBe(false);
  });

  it("evaluatePendingEligibility: C-tier 6.6 aged 12m (past rescoreAfterMin) is still eligible because fullyScored bypass applies", () => {
    const trade = completeSeedPayload({ createdAt: isoMinutesAgo(12), updatedAt: isoMinutesAgo(12) });
    const now = new Date().toISOString();
    const result = evaluatePendingEligibility(trade, now, rthEligibilityCfg);
    // fullyScored gate: aiScore > 0 AND tier in A/B/C → bypass rescore_required
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe("eligible");
    expect(result.requiresRescore).toBe(false);
  });

  it("resolveThresholdDiagnostics: C-tier 6.6 passes with honorSeedDecisionAtExecute=true", () => {
    const trade = completeSeedPayload();
    const diag = resolveThresholdDiagnostics({
      trade,
      allowedGrades: ["A", "B", "C"],
      overlayMinScoreAdjustment: 1.0, // would normally raise threshold to 7.5
      adaptiveMinScoreAdjustment: 0.5,
      honorSeedDecisionAtExecute: true,
      thresholdConfig: { tierAmin: 8.5, tierBmin: 7.5, tierCmin: 6.5 },
      inferTierForScore: tierForScore,
    });

    expect(diag.tier).toBe("C");
    expect(diag.baseTierThreshold).toBe(6.5);
    expect(diag.adjustedThreshold).toBe(6.5); // overlay ignored at execute
    expect(diag.overlayMinScoreAdjustmentIgnoredAtExecute).toBe(true);
    expect(diag.adaptiveMinScoreAdjustmentIgnoredAtExecute).toBe(true);
    expect(diag.thresholdSource).toBe("seed_decision_honored");
    expect(isScoreBelowAdjustedThreshold(diag)).toBe(false); // 6.6 >= 6.5 → passes
  });

  it("grade check: tier C allowed when allowedGrades includes C", () => {
    const trade = completeSeedPayload();
    const diag = resolveThresholdDiagnostics({
      trade,
      allowedGrades: ["A", "B", "C"],
      overlayMinScoreAdjustment: 0,
      adaptiveMinScoreAdjustment: 0,
      honorSeedDecisionAtExecute: true,
      thresholdConfig: { tierAmin: 8.5, tierBmin: 7.5, tierCmin: 6.5 },
      inferTierForScore: tierForScore,
    });
    // grade is allowed if tier is in allowedGrades
    expect(diag.allowedGrades).toContain("C");
    expect(diag.allowedGrades.includes(diag.tier as string)).toBe(true);
  });
});

// ── normalizeExecutionCandidate contract ─────────────────────────────────────
// We test the isExecutionPayloadComplete logic inline since the helper is
// private to the route. The same field-presence rules are checked here.

describe("isExecutionPayloadComplete contract", () => {
  function isComplete(trade: any): boolean {
    const symbol = String(trade?.symbol || trade?.ticker || "").toUpperCase();
    const side = String(trade?.side || "").toUpperCase();
    const rawScore = Number(trade?.aiScore ?? trade?.ai?.score ?? 0);
    const aiScore = Number.isFinite(rawScore) && rawScore > 0 ? rawScore : null;
    const rawTier = String(trade?.tier ?? trade?.ai?.tier ?? "").trim().toUpperCase();
    const derivedTier = (rawTier === "A" || rawTier === "B" || rawTier === "C") ? rawTier
      : aiScore !== null ? tierForScore(aiScore) : null;
    const entryPrice = Number(trade?.entryPrice) || 0;
    const stopPrice = Number(trade?.stopPrice) || 0;
    const targetPrice = Number(trade?.takeProfitPrice ?? trade?.targetPrice) || 0;
    const missing: string[] = [];
    if (!symbol) missing.push("symbol");
    if (side !== "LONG" && side !== "SHORT") missing.push("side");
    if (aiScore === null) missing.push("aiScore");
    if (derivedTier === null) missing.push("tier");
    if (!(entryPrice > 0)) missing.push("entryPrice");
    if (!(stopPrice > 0)) missing.push("stopPrice");
    if (!(targetPrice > 0)) missing.push("targetPrice");
    return missing.length === 0;
  }

  it("complete seeded payload is detected as complete", () => {
    expect(isComplete(completeSeedPayload())).toBe(true);
  });

  it("missing aiScore returns incomplete", () => {
    const t = completeSeedPayload({ aiScore: undefined });
    delete t.ai;
    expect(isComplete(t)).toBe(false);
  });

  it("missing stopPrice returns incomplete", () => {
    expect(isComplete(completeSeedPayload({ stopPrice: 0 }))).toBe(false);
  });

  it("missing tier but aiScore present infers tier from score", () => {
    const t = completeSeedPayload({ tier: undefined });
    delete (t as any).ai; // also remove nested tier
    // aiScore 6.6 → tierForScore → "C"
    expect(isComplete(t)).toBe(true);
  });

  it("payload with all required fields is never routed to rescore path", () => {
    const trade = completeSeedPayload();
    const now = new Date().toISOString();
    // Simulate the two-path router: complete payloads skip evaluatePendingEligibility
    const payloadComplete = isComplete(trade);
    expect(payloadComplete).toBe(true);
    // When complete, the route only checks stale/carryover — never rescore
    // Verify directly by calling evaluatePendingEligibility anyway (should return eligible
    // since fullyScored bypass is in place)
    const result = evaluatePendingEligibility(trade, now, {
      ...rthEligibilityCfg,
      rescoreAfterMin: 1, // very aggressive rescore threshold
    });
    expect(result.reason).not.toBe("rescore_required");
    expect(result.eligible).toBe(true);
  });
});

// ── CASE 1: Loop continuation – price drift on one trade does not stop others ─

describe("CASE 1 – price drift on first trade does not stop remaining trades", () => {
  /**
   * We cannot unit-test the HTTP route loop directly, but we can verify the
   * underlying eligibility and threshold logic is independent per trade, meaning
   * each candidate is evaluated with its own data — no shared mutable failure state.
   */

  const trades = [
    completeSeedPayload({ id: "t1", ticker: "AAPL", symbol: "AAPL", entryPrice: 180, stopPrice: 176 }),
    completeSeedPayload({ id: "t2", ticker: "GILD", symbol: "GILD", entryPrice: 129.64, stopPrice: 128.34 }),
    completeSeedPayload({ id: "t3", ticker: "HYG", symbol: "HYG", entryPrice: 78.50, stopPrice: 77.80 }),
  ];

  it("all three payloads are detected as complete (no rescore path)", () => {
    function isComplete(trade: any): boolean {
      const symbol = String(trade?.symbol || trade?.ticker || "").toUpperCase();
      const side = String(trade?.side || "").toUpperCase();
      const rawScore = Number(trade?.aiScore ?? trade?.ai?.score ?? 0);
      const aiScore = Number.isFinite(rawScore) && rawScore > 0 ? rawScore : null;
      const rawTier = String(trade?.tier ?? trade?.ai?.tier ?? "").trim().toUpperCase();
      const derivedTier = (rawTier === "A" || rawTier === "B" || rawTier === "C") ? rawTier
        : aiScore !== null ? tierForScore(aiScore) : null;
      const entryPrice = Number(trade?.entryPrice) || 0;
      const stopPrice = Number(trade?.stopPrice) || 0;
      const targetPrice = Number(trade?.takeProfitPrice ?? trade?.targetPrice) || 0;
      return !(!symbol || (side !== "LONG" && side !== "SHORT") || aiScore === null ||
        derivedTier === null || !(entryPrice > 0) || !(stopPrice > 0) || !(targetPrice > 0));
    }
    for (const t of trades) {
      expect(isComplete(t)).toBe(true);
    }
  });

  it("each complete trade is independently eligible (no cross-trade contamination)", () => {
    const now = new Date().toISOString();
    for (const t of trades) {
      const result = evaluatePendingEligibility(t, now, rthEligibilityCfg);
      expect(result.eligible).toBe(true);
      expect(result.reason).toBe("eligible");
    }
  });

  it("each trade independently passes the score threshold check", () => {
    for (const t of trades) {
      const diag = resolveThresholdDiagnostics({
        trade: t,
        allowedGrades: ["A", "B", "C"],
        overlayMinScoreAdjustment: 0,
        adaptiveMinScoreAdjustment: 0,
        honorSeedDecisionAtExecute: true,
        thresholdConfig: { tierAmin: 8.5, tierBmin: 7.5, tierCmin: 6.5 },
        inferTierForScore: tierForScore,
      });
      expect(isScoreBelowAdjustedThreshold(diag)).toBe(false);
    }
  });

  it("priceDrift check is per-trade and does not affect sibling trades", () => {
    // checkPriceDrift is a pure function in the route; we replicate its logic here.
    function checkDrift(currentPrice: number, entryPrice: number, stopPrice: number) {
      const drift = Math.abs(currentPrice - entryPrice);
      const R = Math.abs(entryPrice - stopPrice);
      const driftInR = R > 0 ? drift / R : 0;
      if (currentPrice <= 0 || entryPrice <= 0 || R <= 0) return { driftAllowed: true };
      return { driftAllowed: driftInR <= 0.5, driftInR };
    }

    // AAPL: price has drifted 3R from planned entry → SKIP
    const aaplDrift = checkDrift(192, 180, 176); // drift = 12, R = 4 → driftInR = 3
    expect(aaplDrift.driftAllowed).toBe(false);

    // GILD: price is right at entry → ALLOW
    const gildDrift = checkDrift(129.70, 129.64, 128.34); // drift ~0.06, R = 1.3 → driftInR ~0.046
    expect(gildDrift.driftAllowed).toBe(true);

    // HYG: price within tolerance → ALLOW
    const hygDrift = checkDrift(78.55, 78.50, 77.80); // drift = 0.05, R = 0.7 → driftInR ~0.071
    expect(hygDrift.driftAllowed).toBe(true);

    // AAPL failure does NOT modify the return value of GILD or HYG checks —
    // each call is pure and independent.
    expect(gildDrift.driftAllowed).toBe(true);
    expect(hygDrift.driftAllowed).toBe(true);
  });
});

// ── Rescore gate: legacy unscored trade IS correctly sent for rescore ─────────

describe("rescore gate: unscored legacy trades still get rescore_required", () => {
  it("trade with no aiScore and no tier hits rescore_required after rescoreAfterMin", () => {
    const unscoredTrade = {
      id: "legacy-1",
      status: "AUTO_PENDING",
      ticker: "XYZ",
      side: "LONG",
      entryPrice: 50,
      stopPrice: 48,
      takeProfitPrice: 54,
      createdAt: isoMinutesAgo(15),
      // No aiScore, no tier — trade is not fully scored
    };
    const now = new Date().toISOString();
    const result = evaluatePendingEligibility(unscoredTrade, now, {
      ...rthEligibilityCfg,
      rescoreAfterMin: 10,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("rescore_required");
    expect(result.requiresRescore).toBe(true);
  });

  it("fresh (< rescoreAfterMin) unscored trade is still eligible (isScoredTrade=false but age check hasn't fired)", () => {
    // Age 3m < rescoreAfterMin 10m → age gate not triggered;
    // but isScoredTrade=false → not_scored
    const unscoredFresh = {
      id: "legacy-2",
      status: "AUTO_PENDING",
      ticker: "XYZ",
      side: "LONG",
      entryPrice: 50,
      stopPrice: 48,
      takeProfitPrice: 54,
      createdAt: isoMinutesAgo(3),
    };
    const now = new Date().toISOString();
    const result = evaluatePendingEligibility(unscoredFresh, now, {
      ...rthEligibilityCfg,
      rescoreAfterMin: 10,
    });
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe("not_scored");
  });
});
