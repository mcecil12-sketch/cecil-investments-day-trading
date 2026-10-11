import { describe, expect, it } from "vitest";
import { computeSp500Period, computeWindowReturn, windowStartDate } from "@/lib/benchmark/sp500Comparator";
import type { PricePoint } from "@/lib/agents/marketData";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const day = (s: string) => s;

/** Closes keyed by date string, sorted. */
function series(entries: Array<[string, number]>): PricePoint[] {
  return entries.map(([date, close]) => ({ date: d(date), close }));
}

describe("windowStartDate", () => {
  it("YTD is Dec 31 of the prior year", () => {
    expect(windowStartDate("ytd", d("2026-09-30")).toISOString().slice(0, 10)).toBe("2025-12-31");
  });
  it("1Y/3Y are the same calendar date one/three years earlier; Feb 29 clamps", () => {
    expect(windowStartDate("1y", d("2026-09-30")).toISOString().slice(0, 10)).toBe("2025-09-30");
    expect(windowStartDate("3y", d("2026-09-30")).toISOString().slice(0, 10)).toBe("2023-09-30");
    expect(windowStartDate("1y", d("2028-02-29")).toISOString().slice(0, 10)).toBe("2027-02-28");
  });
});

describe("computeSp500Period", () => {
  const s = series([
    ["2023-09-29", 100], // Fri before a Sat 2023-09-30 3Y start
    ["2025-09-30", 150],
    ["2025-12-31", 160],
    ["2026-09-30", 200],
  ]);

  it("YTD = last close of the prior year to the end date", () => {
    expect(computeSp500Period(s, "ytd", d("2026-09-30"))!.value).toBeCloseTo(200 / 160 - 1);
  });

  it("1Y uses the same date one year earlier", () => {
    expect(computeSp500Period(s, "1y", d("2026-09-30"))!.value).toBeCloseTo(200 / 150 - 1);
  });

  it("3Y is annualized (CAGR), and a weekend/holiday start snaps to the prior trading day", () => {
    const r = computeSp500Period(s, "3y", d("2026-09-30"))!;
    expect(r.annualized).toBe(true);
    expect(r.startDate.toISOString().slice(0, 10)).toBe("2023-09-29");
    expect(r.value).toBeCloseTo(Math.pow(2, 1 / 3) - 1, 3);
  });

  it("returns null when the series does not reach back to the window start", () => {
    expect(computeSp500Period(series([["2025-12-31", 160], ["2026-09-30", 200]]), "1y", d("2026-09-30"))).toBeNull();
  });

  it("a New Year's holiday: YTD start falls on the last close before Jan 1", () => {
    const hol = series([["2025-12-30", 90], ["2026-01-02", 95], ["2026-06-30", 99]]);
    expect(computeSp500Period(hol, "ytd", d("2026-06-30"))!.value).toBeCloseTo(99 / 90 - 1);
  });

  it("window ends on the last close on/before the end date", () => {
    const r = computeWindowReturn(series([["2026-01-02", 100], ["2026-02-02", 110], ["2026-03-02", 120]]), d("2026-01-01"), d("2026-02-15"), false);
    expect(r).toBeNull(); // nothing at/before the start
    const r2 = computeWindowReturn(series([["2025-12-31", 100], ["2026-02-02", 110], ["2026-03-02", 120]]), d("2026-01-01"), d("2026-02-15"), false)!;
    expect(r2.value).toBeCloseTo(0.1);
    expect(r2.endDate.toISOString().slice(0, 10)).toBe("2026-02-02");
  });
});
void day;
