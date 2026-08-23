import { describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { candidateRecommendationLog: { findMany } },
}));

const { computeZeroMissMonth } = await import("@/lib/agents/zeroMissAggregation");

function row(symbol: string, batchTag: string, isoDate: string) {
  return { symbol, batchTag, recommendedAt: new Date(isoDate) };
}

describe("computeZeroMissMonth", () => {
  it("qualifies only symbols present in every distinct weekly batch that month", async () => {
    findMany.mockResolvedValueOnce([
      row("AAPL", "top15-2026-08-01", "2026-08-01"),
      row("MSFT", "top15-2026-08-01", "2026-08-01"),
      row("AAPL", "top15-2026-08-08", "2026-08-08"),
      row("GOOG", "top15-2026-08-08", "2026-08-08"),
      row("AAPL", "top15-2026-08-15", "2026-08-15"),
    ]);

    const result = await computeZeroMissMonth("2026-08");

    expect(result.snapshotCount).toBe(3);
    expect(result.qualifyingSymbols).toEqual([{ symbol: "AAPL", appearances: 3 }]);
  });

  it("labels a month with fewer batches logged so far as in-progress when it's the current month", async () => {
    findMany.mockResolvedValueOnce([row("AAPL", "top15-2026-08-01", "2026-08-01")]);
    const currentMonthKey = `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`;
    const result = await computeZeroMissMonth(currentMonthKey);
    expect(result.isCurrentMonth).toBe(true);
  });

  it("does not label a past month as in-progress", async () => {
    findMany.mockResolvedValueOnce([row("AAPL", "top15-2020-01-01", "2020-01-01")]);
    const result = await computeZeroMissMonth("2020-01");
    expect(result.isCurrentMonth).toBe(false);
  });

  it("returns an empty qualifying list when there are no batches at all", async () => {
    findMany.mockResolvedValueOnce([]);
    const result = await computeZeroMissMonth("2026-08");
    expect(result.snapshotCount).toBe(0);
    expect(result.qualifyingSymbols).toEqual([]);
  });

  it("excludes a symbol that missed even one of the month's batches", async () => {
    findMany.mockResolvedValueOnce([
      row("AAPL", "top15-2026-08-01", "2026-08-01"),
      row("AAPL", "top15-2026-08-08", "2026-08-08"),
      row("MSFT", "top15-2026-08-08", "2026-08-08"),
    ]);
    const result = await computeZeroMissMonth("2026-08");
    expect(result.snapshotCount).toBe(2);
    expect(result.qualifyingSymbols.map((q) => q.symbol)).toEqual(["AAPL"]);
  });
});
