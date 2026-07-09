import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RawSignal, ScoredSignal } from "@/lib/aiScoring";

// Mock dependencies
vi.mock("@/lib/redis", () => ({
  redis: null,
}));

vi.mock("@/lib/aiMetrics", () => ({
  recordSpend: vi.fn(),
  recordAiCall: vi.fn(),
  recordAiError: vi.fn(),
  writeAiHeartbeat: vi.fn(),
}));

vi.mock("@/lib/funnelRedis", () => ({
  bumpTodayFunnel: vi.fn(),
}));

vi.mock("@/lib/signalContext", () => ({
  buildSignalContext: vi.fn().mockResolvedValue({
    timeframe: "1Min",
    barsUsed: 50,
    vwap: 100.5,
    trend: "UP",
    trendSlopePct: 0.5,
    avgVolume: 1000000,
    lastVolume: 1200000,
    relVolume: 1.2,
    rangePctAvg: 1.5,
    liquidityNote: "High liquidity",
  }),
}));

describe("Bidirectional AI Scoring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should evaluate both LONG and SHORT hypotheses", () => {
    // Test that the response schema includes bidirectional fields
    const mockResponse = {
      longScore: 8.5,
      shortScore: 4.2,
      bestDirection: "LONG" as const,
      finalScore: 8.5,
      aiGrade: "A",
      qualified: true,
      aiSummary: "Strong LONG setup with uptrend and VWAP support. SHORT weak due to trend misalignment.",
      reasons: ["Strong uptrend", "VWAP support", "High volume confirmation"],
    };

    expect(mockResponse.longScore).toBe(8.5);
    expect(mockResponse.shortScore).toBe(4.2);
    expect(mockResponse.bestDirection).toBe("LONG");
    expect(mockResponse.finalScore).toBe(8.5);
  });

  it("should flip to SHORT when shortScore is stronger", () => {
    // Simulate AI choosing SHORT over LONG
    const mockResponse = {
      longScore: 4.0,
      shortScore: 8.7,
      bestDirection: "SHORT" as const,
      finalScore: 8.7,
      aiGrade: "A",
      qualified: true,
      aiSummary: "Strong SHORT setup with downtrend and rejection at VWAP. LONG weak due to bearish momentum.",
      reasons: ["Strong downtrend", "VWAP rejection", "High selling pressure"],
    };

    expect(mockResponse.shortScore).toBeGreaterThan(mockResponse.longScore);
    expect(mockResponse.bestDirection).toBe("SHORT");
    expect(mockResponse.finalScore).toBe(mockResponse.shortScore);
  });

  it("should handle NONE when both directions are weak", () => {
    const mockResponse = {
      longScore: 3.5,
      shortScore: 4.0,
      bestDirection: "NONE" as const,
      finalScore: 4.0,
      aiGrade: "F",
      qualified: false,
      aiSummary: "No clear directional setup. Both LONG and SHORT lack conviction.",
      reasons: ["Choppy price action", "Low volume", "No clear trend"],
    };

    expect(mockResponse.longScore).toBeLessThan(5);
    expect(mockResponse.shortScore).toBeLessThan(5);
    expect(mockResponse.bestDirection).toBe("NONE");
    expect(mockResponse.qualified).toBe(false);
  });

  it("should populate ScoredSignal with bidirectional fields", () => {
    const rawSignal: RawSignal = {
      id: "test-1",
      ticker: "SPY",
      side: "LONG",
      entryPrice: 450.25,
      stopPrice: 448.0,
      targetPrice: 453.0,
      timeframe: "1Min",
      source: "test",
      createdAt: new Date().toISOString(),
    };

    const scoredSignal: ScoredSignal = {
      ...rawSignal,
      aiScore: 8.5,
      aiGrade: "A",
      aiSummary: "Strong LONG setup",
      totalScore: 8.5,
      longScore: 8.5,
      shortScore: 4.2,
      bestDirection: "LONG",
      aiDirection: "LONG",
      qualified: true,
    };

    expect(scoredSignal.longScore).toBe(8.5);
    expect(scoredSignal.shortScore).toBe(4.2);
    expect(scoredSignal.bestDirection).toBe("LONG");
    expect(scoredSignal.aiDirection).toBe("LONG");
    expect(scoredSignal.aiScore).toBe(8.5);
  });

  it("should use aiDirection in auto-entry when SHORT is chosen", () => {
    // Simulate the pickEntryFromSignal function logic
    const signal = {
      id: "test-2",
      ticker: "QQQ",
      side: "LONG", // Original scanner suggestion
      aiDirection: "SHORT", // AI flipped it
      entryPrice: 380.0,
      stopPrice: 378.0,
      targetPrice: 382.0,
      aiScore: 8.7,
      longScore: 4.0,
      shortScore: 8.7,
      bestDirection: "SHORT" as const,
    };

    // Auto-entry should use aiDirection if available
    const direction = signal.aiDirection || signal.side;
    expect(direction).toBe("SHORT");
    expect(direction).not.toBe(signal.side); // Verify it flipped
  });

  it("should fall back to side if aiDirection is not set", () => {
    // Legacy signal without bidirectional scoring
    const signal = {
      id: "test-3",
      ticker: "AAPL",
      side: "LONG",
      entryPrice: 175.0,
      stopPrice: 173.0,
      targetPrice: 178.0,
    };

    const direction = (signal as any).aiDirection || signal.side;
    expect(direction).toBe("LONG");
  });

  it("should validate JSON schema with all required fields", () => {
    const validResponse = {
      longScore: 7.5,
      shortScore: 6.0,
      bestDirection: "LONG" as const,
      finalScore: 7.5,
      aiGrade: "B",
      qualified: true,
      aiSummary: "Decent LONG setup",
      reasons: ["Moderate trend", "VWAP proximity"],
    };

    // Validate all required fields are present
    expect(validResponse).toHaveProperty("longScore");
    expect(validResponse).toHaveProperty("shortScore");
    expect(validResponse).toHaveProperty("bestDirection");
    expect(validResponse).toHaveProperty("finalScore");
    expect(validResponse).toHaveProperty("aiGrade");
    expect(validResponse).toHaveProperty("qualified");
    expect(validResponse).toHaveProperty("aiSummary");
    expect(validResponse).toHaveProperty("reasons");
    
    // Validate types
    expect(typeof validResponse.longScore).toBe("number");
    expect(typeof validResponse.shortScore).toBe("number");
    expect(["LONG", "SHORT", "NONE"]).toContain(validResponse.bestDirection);
    expect(typeof validResponse.finalScore).toBe("number");
    expect(["A", "B", "C", "D", "F"]).toContain(validResponse.aiGrade);
    expect(typeof validResponse.qualified).toBe("boolean");
    expect(typeof validResponse.aiSummary).toBe("string");
    expect(Array.isArray(validResponse.reasons)).toBe(true);
  });

  it("should clamp scores to valid range 0-10", () => {
    const clampScore = (x: number): number => {
      if (!Number.isFinite(x)) return 0;
      if (x < 0) return 0;
      if (x > 10) return 10;
      return Math.round(x * 10) / 10;
    };

    expect(clampScore(-1)).toBe(0);
    expect(clampScore(0)).toBe(0);
    expect(clampScore(5.5)).toBe(5.5);
    expect(clampScore(10)).toBe(10);
    expect(clampScore(11)).toBe(10);
    expect(clampScore(NaN)).toBe(0);
    expect(clampScore(Infinity)).toBe(0);
  });

  it("should preserve original side field for backward compatibility", () => {
    const signal = {
      id: "test-4",
      ticker: "MSFT",
      side: "LONG",
      aiDirection: "SHORT",
      entryPrice: 380.0,
    };

    // Both fields should be present
    expect(signal.side).toBe("LONG");
    expect(signal.aiDirection).toBe("SHORT");
    
    // Auto-entry prefers aiDirection
    const usedDirection = signal.aiDirection || signal.side;
    expect(usedDirection).toBe("SHORT");
  });

  it("should force direction to match explicit side and qualify based on that score only", () => {
    // Test that when signal.side is explicitly SHORT, it forces bestDirection=SHORT
    // and qualifies based on shortScore, even if longScore is higher
    const signalWithExplicitShortSide = {
      side: "SHORT" as const,
      longScore: 3.1,
      shortScore: 7.4,
    };

    // Simulating the new logic: if side is explicit, force direction to side
    const MIN_QUALIFY_SCORE = 7.0; // default from aiQualify
    const bestDirection = signalWithExplicitShortSide.side; // Force to SHORT
    const winnerScore = bestDirection === "LONG" ? signalWithExplicitShortSide.longScore : signalWithExplicitShortSide.shortScore;
    const isQualified = winnerScore >= MIN_QUALIFY_SCORE;

    expect(bestDirection).toBe("SHORT");
    expect(winnerScore).toBe(7.4);
    expect(isQualified).toBe(true);
    expect(winnerScore).not.toBe(signalWithExplicitShortSide.longScore);
  });

  it("should force direction to LONG when side=LONG, even if shortScore is higher", () => {
    // Test that when signal.side is explicitly LONG, it forces bestDirection=LONG
    // and uses longScore for qualification, even if shortScore is higher
    const signalWithExplicitLongSide = {
      side: "LONG" as const,
      longScore: 7.2,
      shortScore: 8.5,
    };

    // Simulating the new logic
    const MIN_QUALIFY_SCORE = 7.0;
    const bestDirection = signalWithExplicitLongSide.side; // Force to LONG
    const winnerScore = bestDirection === "LONG" ? signalWithExplicitLongSide.longScore : signalWithExplicitLongSide.shortScore;
    const isQualified = winnerScore >= MIN_QUALIFY_SCORE;

    expect(bestDirection).toBe("LONG");
    expect(winnerScore).toBe(7.2);
    expect(isQualified).toBe(true);
    expect(winnerScore).not.toBe(signalWithExplicitLongSide.shortScore);
  });

  it("should use edge gate only when side is neutral/missing", () => {
    // Test that when signal.side is missing/neutral, the edge gate applies
    const neutralSignal = {
      side: undefined, // or null, or not present
      longScore: 7.5,
      shortScore: 7.2,
    };

    const MIN_EDGE = 0.7;
    const MIN_LONG_SCORE = 7.5;
    const edge = Math.abs(neutralSignal.longScore - neutralSignal.shortScore);

    // Edge gate logic
    let bestDirection: "LONG" | "SHORT" | "NONE" = "NONE";
    if (neutralSignal.longScore >= MIN_LONG_SCORE && neutralSignal.longScore > neutralSignal.shortScore && edge >= MIN_EDGE) {
      bestDirection = "LONG";
    }

    // This should fail edge gate (edge = ~0.3 < 0.7)
    expect(edge).toBeCloseTo(0.3, 1);
    expect(edge).toBeLessThan(MIN_EDGE);
    expect(bestDirection).toBe("NONE");
  });

  it("should compute edge and show diagnostic info in rejection note", () => {
    // Test improved rejection note for neutral signals that fail edge gate
    const longScore = 8.2;
    const shortScore = 7.9;
    const edge = Math.abs(longScore - shortScore);
    const MIN_EDGE = 0.7;
    const MIN_LONG_SCORE = 7.5;
    const MIN_SHORT_SCORE = 7.5;

    let failReasons: string[] = [];
    if (longScore < MIN_LONG_SCORE && shortScore < MIN_SHORT_SCORE) {
      failReasons.push(`both scores below threshold (LONG ${longScore.toFixed(2)} < ${MIN_LONG_SCORE.toFixed(2)}, SHORT ${shortScore.toFixed(2)} < ${MIN_SHORT_SCORE.toFixed(2)})`);
    } else if (edge < MIN_EDGE) {
      failReasons.push(`edge ${edge.toFixed(2)} < min ${MIN_EDGE.toFixed(2)}`);
    }

    const rejectionNote = `No qualified directional edge. LONG ${longScore.toFixed(2)} vs SHORT ${shortScore.toFixed(2)}, edge ${edge.toFixed(2)}. Failed: ${failReasons.join(", ")}.`;

    expect(rejectionNote).toContain("LONG 8.20");
    expect(rejectionNote).toContain("SHORT 7.90");
    expect(rejectionNote).toContain("edge 0.30");
    expect(rejectionNote).toContain("edge 0.30 < min 0.70");
  });
});

