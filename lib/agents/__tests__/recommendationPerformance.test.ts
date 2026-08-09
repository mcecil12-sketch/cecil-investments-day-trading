import { describe, expect, it } from "vitest";
import {
  buildPickQualityPoint,
  buildTrackedPositions,
  effectiveStartFor,
  groupIntoWeeklyBatches,
  type TrackedPosition,
} from "@/lib/agents/recommendationPerformance";
import type { PricePoint } from "@/lib/agents/marketData";

function utcDate(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d));
}

function price(dateStr: string, close: number): PricePoint {
  return { date: new Date(`${dateStr}T00:00:00Z`), close };
}

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

describe("effectiveStartFor", () => {
  it("uses the window start for a position that entered before the window opened", () => {
    const entry = utcDate(2026, 0, 1);
    const windowStart = utcDate(2026, 0, 15);
    expect(effectiveStartFor(entry, windowStart)).toEqual(windowStart);
  });

  it("uses the position's own entryDate when it entered after the window opened — can't re-base before it existed", () => {
    const entry = utcDate(2026, 0, 20);
    const windowStart = utcDate(2026, 0, 15);
    expect(effectiveStartFor(entry, windowStart)).toEqual(entry);
  });

  it("uses entryDate unchanged when windowStart is null (the 'All' view)", () => {
    const entry = utcDate(2026, 0, 20);
    expect(effectiveStartFor(entry, null)).toEqual(entry);
  });
});

describe("buildPickQualityPoint", () => {
  const position = (symbol: string, entryDate: Date): TrackedPosition => ({
    symbol,
    entryDate,
    entryScore: 80,
    exitDate: null,
  });

  it("re-bases a pick's return to the window start rather than its since-inception return", () => {
    // AAPL entered well before the window; its price only moves within the window (100 -> 110 -> 121).
    const aaplPrices = [price("2026-01-01", 100), price("2026-01-08", 110), price("2026-01-15", 121)];
    const spxPrices = [price("2026-01-01", 1000), price("2026-01-08", 1000), price("2026-01-15", 1000)];
    const priceBySymbol = new Map([["AAPL", aaplPrices]]);
    const positions = [position("AAPL", utcDate(2026, 0, 1))];
    const windowStart = utcDate(2026, 0, 8);
    const date = utcDate(2026, 0, 15);

    const point = buildPickQualityPoint(date, positions, priceBySymbol, spxPrices, windowStart);

    // Since-inception return would be (121-100)/100 = 0.21; the correct windowed return is (121-110)/110 = 0.10.
    expect(point.pickReturn).toBeCloseTo(0.1, 6);
  });

  it("falls back to since-entry return for a pick that entered inside the window (nothing to re-base to)", () => {
    const msftPrices = [price("2026-01-10", 200), price("2026-01-15", 220)];
    const spxPrices = [price("2026-01-10", 1000), price("2026-01-15", 1000)];
    const priceBySymbol = new Map([["MSFT", msftPrices]]);
    const positions = [position("MSFT", utcDate(2026, 0, 10))];
    const windowStart = utcDate(2026, 0, 8);
    const date = utcDate(2026, 0, 15);

    const point = buildPickQualityPoint(date, positions, priceBySymbol, spxPrices, windowStart);

    expect(point.pickReturn).toBeCloseTo((220 - 200) / 200, 6);
  });

  it("averages equal-weighted across positions that entered at different times relative to the window", () => {
    const aaplPrices = [price("2026-01-01", 100), price("2026-01-08", 110), price("2026-01-15", 132)];
    const msftPrices = [price("2026-01-10", 200), price("2026-01-15", 220)];
    const spxPrices = [price("2026-01-01", 1000), price("2026-01-08", 1000), price("2026-01-10", 1000), price("2026-01-15", 1000)];
    const priceBySymbol = new Map([
      ["AAPL", aaplPrices],
      ["MSFT", msftPrices],
    ]);
    const positions = [position("AAPL", utcDate(2026, 0, 1)), position("MSFT", utcDate(2026, 0, 10))];
    const windowStart = utcDate(2026, 0, 8);
    const date = utcDate(2026, 0, 15);

    const point = buildPickQualityPoint(date, positions, priceBySymbol, spxPrices, windowStart);

    // AAPL windowed: (132-110)/110 = 0.2. MSFT since-entry (entered inside window): (220-200)/200 = 0.1.
    expect(point.pickReturn).toBeCloseTo((0.2 + 0.1) / 2, 6);
    expect(point.activeCount).toBe(2);
  });
});
