import { describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { earningsEstimateSnapshot: { findMany } },
}));

const { getEarningsAccelerationScores } = await import("@/lib/agents/earningsAcceleration");

function row(overrides: Record<string, unknown>) {
  return {
    id: "id",
    symbol: "TEST",
    epsEstimateAverageCurrent: null,
    epsEstimateAverage7DaysAgo: null,
    epsEstimateAverage30DaysAgo: null,
    epsEstimateAverage60DaysAgo: null,
    epsEstimateAverage90DaysAgo: null,
    revisionUpTrailing7Days: null,
    revisionDownTrailing7Days: null,
    revisionUpTrailing30Days: null,
    revisionDownTrailing30Days: null,
    hasEstimates: true,
    lastFetchedAt: new Date("2026-07-28T00:00:00Z"),
    lastAttemptedAt: new Date("2026-07-28T00:00:00Z"),
    lastErrorMessage: null,
    updatedAt: new Date("2026-07-28T00:00:00Z"),
    ...overrides,
  };
}

describe("getEarningsAccelerationScores", () => {
  it("falls back to neutral 50 for a symbol never fetched (no row)", async () => {
    findMany.mockResolvedValueOnce([]);
    const result = await getEarningsAccelerationScores(["NEVER"]);
    expect(result.get("NEVER")).toMatchObject({ score: 50, coverage: "not_yet_fetched" });
  });

  it("falls back to neutral 50 when fetched but no coverage exists", async () => {
    findMany.mockResolvedValueOnce([row({ symbol: "NOCOV", hasEstimates: false })]);
    const result = await getEarningsAccelerationScores(["NOCOV"]);
    expect(result.get("NOCOV")).toMatchObject({ score: 50, coverage: "no_coverage" });
  });

  it("scores a rising EPS estimate + positive revision breadth above neutral", async () => {
    findMany.mockResolvedValueOnce([
      row({
        symbol: "UP",
        epsEstimateAverageCurrent: 1.1,
        epsEstimateAverage90DaysAgo: 1.0,
        revisionUpTrailing30Days: 8,
        revisionDownTrailing30Days: 1,
        revisionUpTrailing7Days: 2,
        revisionDownTrailing7Days: 0,
      }),
    ]);
    const result = await getEarningsAccelerationScores(["UP"]);
    const score = result.get("UP")!;
    expect(score.coverage).toBe("covered");
    expect(score.epsTrendPct).toBeCloseTo(0.1, 5);
    expect(score.netRevisionBreadth30d).toBeCloseTo((8 - 1) / 9, 5);
    expect(score.score).toBeGreaterThan(50);
  });

  it("treats confirmed zero revisions (0 up, 0 down) as neutral breadth, not missing", async () => {
    findMany.mockResolvedValueOnce([
      row({ symbol: "ZERO", revisionUpTrailing30Days: 0, revisionDownTrailing30Days: 0 }),
    ]);
    const result = await getEarningsAccelerationScores(["ZERO"]);
    const score = result.get("ZERO")!;
    expect(score.netRevisionBreadth30d).toBe(0);
  });

  it("treats missing revision counts (null/null) as unavailable, not zero", async () => {
    findMany.mockResolvedValueOnce([
      row({ symbol: "MISSING", revisionUpTrailing30Days: null, revisionDownTrailing30Days: null }),
    ]);
    const result = await getEarningsAccelerationScores(["MISSING"]);
    const score = result.get("MISSING")!;
    expect(score.netRevisionBreadth30d).toBeNull();
  });

  it("guards against an unstable ratio when the 90-days-ago EPS estimate is near zero", async () => {
    findMany.mockResolvedValueOnce([
      row({ symbol: "NEARZERO", epsEstimateAverageCurrent: 0.5, epsEstimateAverage90DaysAgo: 0.01 }),
    ]);
    const result = await getEarningsAccelerationScores(["NEARZERO"]);
    expect(result.get("NEARZERO")!.epsTrendPct).toBeNull();
  });
});
