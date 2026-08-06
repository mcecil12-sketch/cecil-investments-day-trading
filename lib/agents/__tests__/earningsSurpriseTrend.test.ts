import { describe, expect, it, vi } from "vitest";

const stateFindMany = vi.fn();
const historyFindMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    earningsFetchState: { findMany: stateFindMany },
    earningsHistory: { findMany: historyFindMany },
  },
}));

const { getEarningsSurpriseTrendScores } = await import("@/lib/agents/earningsSurpriseTrend");

describe("getEarningsSurpriseTrendScores", () => {
  it("falls back to neutral 50 for a symbol never fetched (no fetch-state row)", async () => {
    stateFindMany.mockResolvedValueOnce([]);
    historyFindMany.mockResolvedValueOnce([]);
    const result = await getEarningsSurpriseTrendScores(["NEVER"]);
    expect(result.get("NEVER")).toMatchObject({ score: 50, coverage: "not_yet_fetched", lowConfidence: true });
  });

  it("falls back to neutral 50 when fetched but Alpha Vantage has no reported history", async () => {
    stateFindMany.mockResolvedValueOnce([
      { symbol: "NOCOV", hasHistory: false, lastFetchedAt: new Date("2026-08-01"), lastAttemptedAt: new Date("2026-08-01"), lastErrorMessage: null },
    ]);
    historyFindMany.mockResolvedValueOnce([]);
    const result = await getEarningsSurpriseTrendScores(["NOCOV"]);
    expect(result.get("NOCOV")).toMatchObject({ score: 50, coverage: "no_coverage" });
  });

  it("scores neutral when history rows exist but no quarter has been reported yet (backfill lag, not missing data)", async () => {
    stateFindMany.mockResolvedValueOnce([{ symbol: "PENDING", hasHistory: true, lastFetchedAt: new Date("2026-08-01") }]);
    historyFindMany.mockResolvedValueOnce([
      { symbol: "PENDING", fiscalDateEnding: new Date("2026-06-30"), reportedEPS: null, estimatedEPS: 1.5 },
    ]);
    const result = await getEarningsSurpriseTrendScores(["PENDING"]);
    expect(result.get("PENDING")).toMatchObject({ score: 50, coverage: "insufficient_data" });
  });

  it("falls back to raw surprise percentage when fewer than 8 quarters of reported history exist", async () => {
    stateFindMany.mockResolvedValueOnce([{ symbol: "NEWCO", hasHistory: true, lastFetchedAt: new Date("2026-08-01") }]);
    historyFindMany.mockResolvedValueOnce([
      { symbol: "NEWCO", fiscalDateEnding: new Date("2026-06-30"), reportedEPS: 1.1, estimatedEPS: 1.0 },
      { symbol: "NEWCO", fiscalDateEnding: new Date("2026-03-31"), reportedEPS: 0.95, estimatedEPS: 1.0 },
    ]);
    const result = await getEarningsSurpriseTrendScores(["NEWCO"]);
    const score = result.get("NEWCO")!;
    expect(score.coverage).toBe("raw_surprise_fallback");
    expect(score.lowConfidence).toBe(true);
    expect(score.quartersUsed).toBe(2);
    expect(score.mostRecentSurprisePct).toBeCloseTo(0.1, 5); // (1.10 - 1.00) / 1.00, most recent quarter only
    expect(score.score).toBeGreaterThan(50);
  });

  it("guards against an unstable fallback ratio when the most recent estimatedEPS is near zero", async () => {
    stateFindMany.mockResolvedValueOnce([{ symbol: "NEARZERO", hasHistory: true, lastFetchedAt: new Date("2026-08-01") }]);
    historyFindMany.mockResolvedValueOnce([
      { symbol: "NEARZERO", fiscalDateEnding: new Date("2026-06-30"), reportedEPS: 0.02, estimatedEPS: 0.01 },
    ]);
    const result = await getEarningsSurpriseTrendScores(["NEARZERO"]);
    expect(result.get("NEARZERO")).toMatchObject({ score: 50, coverage: "insufficient_data" });
  });

  it("falls back to raw surprise percentage when 8 quarters exist but have zero variance (degenerate stddev)", async () => {
    stateFindMany.mockResolvedValueOnce([{ symbol: "FLAT", hasHistory: true, lastFetchedAt: new Date("2026-08-01") }]);
    const dates = ["2026-06-30", "2026-03-31", "2025-12-31", "2025-09-30", "2025-06-30", "2025-03-31", "2024-12-31", "2024-09-30"];
    historyFindMany.mockResolvedValueOnce(
      dates.map((d) => ({ symbol: "FLAT", fiscalDateEnding: new Date(d), reportedEPS: 1.05, estimatedEPS: 1.0 })),
    );
    const result = await getEarningsSurpriseTrendScores(["FLAT"]);
    const score = result.get("FLAT")!;
    expect(score.coverage).toBe("raw_surprise_fallback");
    expect(score.mostRecentSurprisePct).toBeCloseTo(0.05, 5);
  });

  it("computes the full recency-weighted SUE + trend formula for 8+ quarters of reported history, independent of row order and ignoring unreported quarters", async () => {
    // idx0 = most recent .. idx7 = oldest of the trailing-8 window.
    const surprises = [0.2, 0.1, 0.0, -0.1, 0.1, 0.1, 0.1, 0.1];
    const dates = ["2026-06-30", "2026-03-31", "2025-12-31", "2025-09-30", "2025-06-30", "2025-03-31", "2024-12-31", "2024-09-30"];

    stateFindMany.mockResolvedValueOnce([{ symbol: "FULL", hasHistory: true, lastFetchedAt: new Date("2026-08-01") }]);
    const rows = dates.map((d, i) => ({
      symbol: "FULL",
      fiscalDateEnding: new Date(d),
      reportedEPS: 1.0 + surprises[i],
      estimatedEPS: 1.0,
    }));
    // An unreported upcoming quarter (backfill lag) and the 8 valid quarters
    // in shuffled order, to confirm the module sorts by fiscalDateEnding
    // itself and correctly excludes the null-reportedEPS row from the window.
    historyFindMany.mockResolvedValueOnce([
      { symbol: "FULL", fiscalDateEnding: new Date("2026-09-30"), reportedEPS: null, estimatedEPS: 1.05 },
      rows[3],
      rows[7],
      rows[0],
      rows[5],
      rows[1],
      rows[6],
      rows[2],
      rows[4],
    ]);

    const result = await getEarningsSurpriseTrendScores(["FULL"]);
    const score = result.get("FULL")!;

    // Independently transcribed reference implementation of the spec, not a
    // copy of the module's internals, to actually catch regressions.
    const mean = surprises.reduce((sum, v) => sum + v, 0) / surprises.length;
    const variance = surprises.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (surprises.length - 1);
    const stdDev = Math.sqrt(variance);
    const sue = surprises.slice(0, 4).map((s) => s / stdDev);
    const weightedSue = 0.4 * sue[0] + 0.3 * sue[1] + 0.2 * sue[2] + 0.1 * sue[3];
    const trend = sue[0] - sue[1];
    const rawScore = 0.7 * weightedSue + 0.3 * trend;
    const ceiling = 3;
    const clamped = Math.max(-ceiling, Math.min(ceiling, rawScore));
    const expectedScore = Math.round(((clamped + ceiling) / (2 * ceiling)) * 100);

    expect(score.coverage).toBe("sue");
    expect(score.lowConfidence).toBe(false);
    expect(score.quartersUsed).toBe(8);
    expect(score.weightedSue).toBeCloseTo(weightedSue, 6);
    expect(score.trend).toBeCloseTo(trend, 6);
    expect(score.rawScore).toBeCloseTo(rawScore, 6);
    expect(score.score).toBe(expectedScore);
  });
});
