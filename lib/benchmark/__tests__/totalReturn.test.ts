import { describe, expect, it } from "vitest";
import { computeTotalReturnComparison } from "@/lib/benchmark/totalReturn";
import type { PricePoint } from "@/lib/agents/marketData";

const day = (iso: string) => new Date(`${iso}T14:30:00Z`);
const series = (rows: Array<[string, number]>): PricePoint[] => rows.map(([d, close]) => ({ date: day(d), close }));

/**
 * Real Yahoo v8 chart adjclose values (fetched 2026-10-05) for calendar 2025:
 * VZ and ^SP500TR on the last trading day of 2024 and of 2025. Only ratios
 * within a single fetch are meaningful (adjclose rebases on each dividend).
 */
const VZ_ADJ = series([
  ["2024-12-31", 35.62379837036133],
  ["2025-12-31", 38.78104782104492],
]);
const SP500TR = series([
  ["2024-12-31", 12911.8203125],
  ["2025-12-31", 15220.4501953125],
]);

describe("computeTotalReturnComparison", () => {
  it("matches a manual calculation for a fixed real window (calendar 2025)", () => {
    const result = computeTotalReturnComparison(VZ_ADJ, SP500TR)!;

    // Manual: 38.78104782104492 / 35.62379837036133 - 1 and 15220.4501953125 / 12911.8203125 - 1
    expect(result.ytd.portfolioReturn).toBeCloseTo(0.08862753538686086, 12);
    expect(result.ytd.sp500Return).toBeCloseTo(0.17879972203280303, 12);
    expect(result.ytd.alpha).toBeCloseTo(0.08862753538686086 - 0.17879972203280303, 12);
    expect(result["1y"].portfolioReturn).toBeCloseTo(0.08862753538686086, 12);
    expect(result.ytd.asOfDate.toISOString()).toBe("2025-12-31T00:00:00.000Z");
  });

  it("agrees with an independent reinvest-dividends-at-ex-date calc from raw closes", () => {
    // Raw closes 39.99 -> 40.73 with 4 real 2025 VZ dividends reinvested at the
    // ex-date close (0.678 @ 37.81, 0.678 @ 42.92, 0.678 @ 42.03, 0.69 @ 39.85).
    const shares = (1 + 0.678 / 37.81) * (1 + 0.678 / 42.92) * (1 + 0.678 / 42.03) * (1 + 0.69 / 39.85);
    const manualTotalReturn = (40.73 * shares) / 39.99 - 1;
    const priceOnly = 40.73 / 39.99 - 1;

    const result = computeTotalReturnComparison(VZ_ADJ, SP500TR)!;
    expect(result.ytd.portfolioReturn).toBeCloseTo(manualTotalReturn, 3);
    expect(result.ytd.portfolioReturn!).toBeGreaterThan(priceOnly + 0.05); // dividends clearly included
  });

  it("uses distinct start dates for YTD and 1Y, and the last close on or before each", () => {
    const stock = series([
      ["2025-03-03", 100], // 1Y start: last close on/before 2025-03-04 (end 2026-03-04 minus 365d)
      ["2025-12-31", 110], // YTD start (last close on/before Dec 31)
      ["2026-03-04", 132],
    ]);
    const index = series([
      ["2025-03-03", 1000],
      ["2025-12-31", 1100],
      ["2026-03-04", 1210],
    ]);
    const r = computeTotalReturnComparison(stock, index)!;
    expect(r.ytd.portfolioReturn).toBeCloseTo(132 / 110 - 1, 12);
    expect(r.ytd.sp500Return).toBeCloseTo(0.1, 12);
    expect(r["1y"].portfolioReturn).toBeCloseTo(132 / 100 - 1, 12);
    expect(r["1y"].alpha).toBeCloseTo(0.32 - 0.21, 12);
  });

  it("ends both windows at the latest date present in both series", () => {
    const stock = series([["2025-12-31", 100], ["2026-03-05", 150]]);
    const index = series([["2025-12-31", 100], ["2026-03-04", 110]]);
    const r = computeTotalReturnComparison(stock, index)!;
    expect(r.ytd.asOfDate.toISOString()).toBe("2026-03-04T00:00:00.000Z");
    expect(r.ytd.portfolioReturn).toBeCloseTo(0, 12); // stock's 03-05 point is ignored
  });

  it("returns null returns when the series doesn't reach back to a window's start", () => {
    const stock = series([["2026-02-01", 100], ["2026-03-04", 110]]);
    const index = series([["2026-02-01", 100], ["2026-03-04", 105]]);
    const r = computeTotalReturnComparison(stock, index)!;
    expect(r.ytd.portfolioReturn).toBeNull();
    expect(r["1y"].alpha).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(computeTotalReturnComparison([], SP500TR)).toBeNull();
  });
});
