import { describe, expect, it } from "vitest";
import {
  averagePairwiseCorrelation,
  briefAgeDays,
  computeAllocation,
  computeSleeveScoreboard,
  computeThemeConcentration,
} from "@/lib/export/sleeveMath";
import type { PricePoint } from "@/lib/agents/marketData";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const series = (entries: Array<[string, number]>): PricePoint[] => entries.map(([date, close]) => ({ date: d(date), close }));

describe("computeSleeveScoreboard", () => {
  const index = series([["2026-10-01", 100], ["2026-10-09", 102]]);
  it("equal-weights the names; contribution = return / N; compares to index and control over the same dates", () => {
    const sb = computeSleeveScoreboard({
      startDate: d("2026-10-01"),
      names: [
        { symbol: "AAA", series: series([["2026-09-30", 50], ["2026-10-09", 55]]) }, // start = close on/before 10-01 -> 50, +10%
        { symbol: "BBB", series: series([["2026-10-01", 20], ["2026-10-09", 19]]) }, // -5%
        { symbol: "NOPE", series: [] },
      ],
      index,
      control: series([["2026-10-01", 200], ["2026-10-09", 203]]), // +1.5%
    })!;
    expect(sb.names.map((n) => n.symbol)).toEqual(["AAA", "BBB"]);
    expect(sb.names[0].ret).toBeCloseTo(0.1);
    expect(sb.names[0].contribution).toBeCloseTo(0.05);
    expect(sb.names[1].contribution).toBeCloseTo(-0.025);
    expect(sb.sleeveReturn).toBeCloseTo(0.025);
    expect(sb.indexReturn).toBeCloseTo(0.02);
    expect(sb.controlReturn).toBeCloseTo(0.015);
    expect(sb.excessVsIndex).toBeCloseTo(0.005);
    expect(sb.missing).toEqual(["NOPE"]);
    expect(sb.endDate.toISOString().slice(0, 10)).toBe("2026-10-09");
  });

  it("returns null without an index series", () => {
    expect(computeSleeveScoreboard({ startDate: d("2026-10-01"), names: [], index: [], control: null })).toBeNull();
  });
});

describe("computeAllocation", () => {
  it("splits sleeve, S&P fund, other and cash", () => {
    const [a] = computeAllocation(
      [{ name: "For Kennedy", holdings: [
        { symbol: "NVDA", isCash: false, value: 30 },
        { symbol: "FXAIX", isCash: false, value: 50 },
        { symbol: "FSELX", isCash: false, value: 15 },
        { symbol: "SPAXX", isCash: true, value: 5 },
      ] }],
      new Set(["NVDA"]),
    );
    expect(a.value).toBe(100);
    expect(a.sleevePct).toBeCloseTo(0.3);
    expect(a.sp500FundPct).toBeCloseTo(0.5);
    expect(a.otherPct).toBeCloseTo(0.15);
    expect(a.cashPct).toBeCloseTo(0.05);
  });
});

describe("theme concentration and correlation", () => {
  it("finds the largest cluster's share of the sleeve", () => {
    const t = computeThemeConcentration([
      { symbol: "A", sector: "Technology" },
      { symbol: "B", sector: "Technology" },
      { symbol: "C", sector: "Technology" },
      { symbol: "D", sector: "Energy" },
    ]);
    expect(t.largest).toEqual({ sector: "Technology", share: 0.75 });
  });

  const dates = Array.from({ length: 70 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)));
  const make = (f: (i: number) => number): PricePoint[] => dates.map((date, i) => ({ date, close: f(i) }));

  it("is ~1 for identical return series and negative for opposite ones", () => {
    const wiggle = (i: number) => 100 * Math.exp(0.02 * Math.sin(i) + 0.001 * i);
    const inverse = (i: number) => 100 * Math.exp(-0.02 * Math.sin(i) + 0.001 * i);
    expect(averagePairwiseCorrelation([make(wiggle), make((i) => wiggle(i) * 2)])).toBeCloseTo(1, 1);
    expect(averagePairwiseCorrelation([make(wiggle), make(inverse)])!).toBeLessThan(-0.9);
  });

  it("is null with one series or too little overlap", () => {
    expect(averagePairwiseCorrelation([make((i) => 100 + i)])).toBeNull();
    expect(averagePairwiseCorrelation([make((i) => 100 + i), make((i) => 100 + i).slice(0, 10)])).toBeNull();
  });
});

describe("briefAgeDays", () => {
  it("counts whole days", () => {
    expect(briefAgeDays(d("2026-10-04"), d("2026-10-16"))).toBe(12);
  });
});
