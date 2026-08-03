import { describe, expect, it } from "vitest";
import { buildTrackedPositions, groupIntoWeeklyBatches } from "@/lib/agents/recommendationPerformance";

function batchDate(n: number): Date {
  return new Date(Date.UTC(2026, 0, 1 + n * 7));
}

function row(batchIdx: number, symbol: string, score: number) {
  return {
    symbol,
    batchTag: `w${batchIdx}`,
    recommendedAt: batchDate(batchIdx),
    score,
  };
}

describe("groupIntoWeeklyBatches", () => {
  it("collapses same-day reruns (duplicate rows under one batchTag) to one row per symbol, latest wins", () => {
    const rows = [
      { symbol: "AAPL", batchTag: "top15-2026-07-25", recommendedAt: new Date("2026-07-25T20:18:43Z"), score: 83 },
      { symbol: "AAPL", batchTag: "top15-2026-07-25", recommendedAt: new Date("2026-07-25T20:18:55Z"), score: 68 },
    ];
    const batches = groupIntoWeeklyBatches(rows);
    expect(batches).toHaveLength(1);
    expect(batches[0].rowsBySymbol.get("AAPL")?.score).toBe(68);
  });

  it("orders batches by date regardless of input order", () => {
    const rows = [row(2, "AAPL", 80), row(0, "AAPL", 90), row(1, "AAPL", 85)];
    const batches = groupIntoWeeklyBatches(rows);
    expect(batches.map((b) => b.batchTag)).toEqual(["w0", "w1", "w2"]);
  });
});

describe("buildTrackedPositions", () => {
  it("holds a symbol across consecutive weekly appearances as a single position", () => {
    const batches = groupIntoWeeklyBatches([row(0, "AAPL", 90), row(1, "AAPL", 88), row(2, "AAPL", 85)]);
    const positions = buildTrackedPositions(batches);
    expect(positions).toEqual([
      { symbol: "AAPL", entryDate: batchDate(0), entryScore: 90, exitDate: null },
    ]);
  });

  it("treats a single missed week as noise — keeps the position open through it", () => {
    const batches = groupIntoWeeklyBatches([row(0, "AAPL", 90), row(1, "MSFT", 80), row(2, "AAPL", 85)]);
    const positions = buildTrackedPositions(batches);
    const aapl = positions.find((p) => p.symbol === "AAPL");
    expect(aapl).toEqual({ symbol: "AAPL", entryDate: batchDate(0), entryScore: 90, exitDate: null });
  });

  it("closes a position after 2 consecutive missed weeks, exiting at the last buffered week", () => {
    const batches = groupIntoWeeklyBatches([
      row(0, "AAPL", 90),
      row(1, "AAPL", 88),
      row(2, "MSFT", 80),
      row(3, "MSFT", 80),
    ]);
    const positions = buildTrackedPositions(batches);
    const aapl = positions.find((p) => p.symbol === "AAPL");
    expect(aapl).toEqual({ symbol: "AAPL", entryDate: batchDate(0), entryScore: 90, exitDate: batchDate(2) });
  });

  it("opens a brand-new position with a fresh cost basis on re-entry after a close", () => {
    const batches = groupIntoWeeklyBatches([
      row(0, "AAPL", 90),
      row(1, "MSFT", 80),
      row(2, "MSFT", 80),
      row(3, "AAPL", 70),
    ]);
    const positions = buildTrackedPositions(batches);
    const aaplPositions = positions.filter((p) => p.symbol === "AAPL");
    expect(aaplPositions).toEqual([
      { symbol: "AAPL", entryDate: batchDate(0), entryScore: 90, exitDate: batchDate(1) },
      { symbol: "AAPL", entryDate: batchDate(3), entryScore: 70, exitDate: null },
    ]);
  });

  it("does not double-close on a 3rd+ consecutive missed week", () => {
    const batches = groupIntoWeeklyBatches([
      row(0, "AAPL", 90),
      row(1, "MSFT", 80),
      row(2, "MSFT", 80),
      row(3, "MSFT", 80),
    ]);
    const positions = buildTrackedPositions(batches);
    const aaplPositions = positions.filter((p) => p.symbol === "AAPL");
    expect(aaplPositions).toEqual([{ symbol: "AAPL", entryDate: batchDate(0), entryScore: 90, exitDate: batchDate(1) }]);
  });

  it("dedupes a symbol appearing in every batch so far into exactly one tracked position", () => {
    const batches = groupIntoWeeklyBatches([
      row(0, "AAPL", 90),
      row(1, "AAPL", 89),
      row(2, "AAPL", 91),
      row(3, "AAPL", 87),
    ]);
    const positions = buildTrackedPositions(batches);
    expect(positions).toHaveLength(1);
  });
});
