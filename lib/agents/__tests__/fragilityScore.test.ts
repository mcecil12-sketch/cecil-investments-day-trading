import { describe, expect, it } from "vitest";
import {
  FRAGILITY_EXTENSION_THRESHOLD,
  FRAGILITY_VOL_THRESHOLD,
  betaVsSpx,
  computeFragility,
  applyFragilityCohort,
  extensionVs200d,
  fragilityFlag,
  percentileRanks,
  vol60d,
} from "@/lib/agents/fragilityScore";
import { MOMENTUM_TREND_WEIGHT, EARNINGS_SURPRISE_TREND_WEIGHT, SECTOR_LEADERSHIP_WEIGHT } from "@/lib/agents/scoringShared";
import { scorePriceSeries } from "@/lib/agents/technicals";
import type { PricePoint } from "@/lib/agents/marketData";

function series(closes: number[]): PricePoint[] {
  return closes.map((close, i) => ({ date: new Date(Date.UTC(2025, 0, 1 + i)), close }));
}
const flat = (n: number, v = 100) => series(Array.from({ length: n }, () => v));

describe("extensionVs200d", () => {
  it("is null with fewer than 200 bars", () => {
    expect(extensionVs200d(flat(199))).toBeNull();
  });
  it("is (last / SMA200) - 1", () => {
    // 199 bars at 100, last at 300 -> SMA = (199*100+300)/200 = 101 -> 300/101 - 1
    const pts = series([...Array.from({ length: 199 }, () => 100), 300]);
    expect(extensionVs200d(pts)).toBeCloseTo(300 / 101 - 1, 10);
  });
  it("is 0 on a flat series and uses only the last 200 bars", () => {
    expect(extensionVs200d(series([1, ...Array.from({ length: 200 }, () => 50)]))).toBeCloseTo(0, 10);
  });
});

describe("vol60d", () => {
  it("is null with fewer than 60 bars", () => {
    expect(vol60d(flat(59))).toBeNull();
  });
  it("is 0 for a flat series", () => {
    expect(vol60d(flat(60))).toBe(0);
  });
  it("annualizes the sample stdev of daily log returns", () => {
    // Alternating +1%/-1% log returns over 60 bars -> 59 returns
    const closes = [100];
    for (let i = 1; i < 60; i++) closes.push(closes[i - 1] * Math.exp(i % 2 ? 0.01 : -0.01));
    const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
    const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, v) => s + (v - mean) ** 2, 0) / (rets.length - 1));
    expect(vol60d(series(closes))).toBeCloseTo(sd * Math.sqrt(252), 10);
  });
});

describe("fragilityFlag", () => {
  it("fires at exactly each threshold (>=)", () => {
    expect(fragilityFlag(FRAGILITY_EXTENSION_THRESHOLD, 0)).toBe(true);
    expect(fragilityFlag(0, FRAGILITY_VOL_THRESHOLD)).toBe(true);
  });
  it("is false just below both thresholds", () => {
    expect(fragilityFlag(0.2499, 0.5999)).toBe(false);
  });
  it("uses whichever metric is available, and is null only if neither is", () => {
    expect(fragilityFlag(null, 0.7)).toBe(true);
    expect(fragilityFlag(0.1, null)).toBe(false);
    expect(fragilityFlag(null, null)).toBeNull();
  });
});

describe("computeFragility", () => {
  it("returns nulls for short history and never throws", () => {
    expect(computeFragility(flat(10))).toEqual({ extensionVs200d: null, vol60d: null, fragilityPercentile: null, fragilityFlag: null });
    expect(computeFragility(null as unknown as PricePoint[])).toEqual({ extensionVs200d: null, vol60d: null, fragilityPercentile: null, fragilityFlag: null });
  });
  it("vol-only metrics with 60-199 bars; flag/percentile are cohort-relative so null here", () => {
    const closes = [100];
    for (let i = 1; i < 100; i++) closes.push(closes[i - 1] * Math.exp(i % 2 ? 0.06 : -0.06));
    const m = computeFragility(series(closes));
    expect(m.extensionVs200d).toBeNull();
    expect(m.vol60d).toBeGreaterThan(0.6);
    expect(m.fragilityFlag).toBeNull();
    expect(m.fragilityPercentile).toBeNull();
  });
});

describe("betaVsSpx", () => {
  it("is ~2 for a stock moving at twice the index's log returns", () => {
    const spx = [100];
    for (let i = 1; i < 120; i++) spx.push(spx[i - 1] * Math.exp(i % 3 === 0 ? -0.01 : 0.005));
    const stock = spx.map((_, i) => Math.exp(2 * Math.log(spx[i] / spx[0])));
    expect(betaVsSpx(series(stock), series(spx))).toBeCloseTo(2, 8);
  });
  it("is null with insufficient overlap", () => {
    expect(betaVsSpx(flat(30), flat(30))).toBeNull();
  });
});

describe("composite score is independent of fragility", () => {
  it("scorePriceSeries and the composite formula are byte-identical regardless of fragility fields", () => {
    const pts = series(Array.from({ length: 400 }, (_, i) => 100 + i * 0.5));
    const composite = (extra: object) => {
      const priceScored = scorePriceSeries(pts);
      const entry = {
        score: Math.max(0, Math.min(100, Math.round(priceScored.score * MOMENTUM_TREND_WEIGHT + 70 * EARNINGS_SURPRISE_TREND_WEIGHT + 60 * SECTOR_LEADERSHIP_WEIGHT))),
        ...extra,
      };
      return JSON.stringify(entry.score);
    };
    expect(composite({})).toBe(composite({ ...computeFragility(pts) }));
    expect(composite({})).toBe(composite({ extensionVs200d: 9, vol60d: 9, fragilityFlag: true }));
  });
});

type Member = { extensionVs200d: number | null; vol60d: number | null; fragilityPercentile: number | null; fragilityFlag: boolean | null };
const m = (extensionVs200d: number | null, vol60d: number | null): Member => ({ extensionVs200d, vol60d, fragilityPercentile: null, fragilityFlag: null });

describe("percentileRanks", () => {
  it("uses mid-ranks so ties share a percentile", () => {
    expect(percentileRanks([1, 2, 3, 4])).toEqual([12.5, 37.5, 62.5, 87.5]);
    expect(percentileRanks([5, 5, 5, 5])).toEqual([50, 50, 50, 50]);
    expect(percentileRanks([1, 2, 2, 3])).toEqual([12.5, 50, 50, 87.5]);
  });
});

describe("applyFragilityCohort (Oct 11 2026 relative definition)", () => {
  it("percentile is the mean of the extension and vol percentile ranks; flags exactly the top third", () => {
    const cohort = Array.from({ length: 9 }, (_, i) => m(i / 10, i / 5)); // both metrics perfectly co-ranked
    applyFragilityCohort(cohort);
    expect(cohort[8].fragilityPercentile).toBeCloseTo(((8 + 0.5) / 9) * 100);
    expect(cohort[0].fragilityPercentile).toBeCloseTo((0.5 / 9) * 100);
    expect(cohort.filter((c) => c.fragilityFlag).length).toBe(3);
    expect(cohort.slice(6).every((c) => c.fragilityFlag)).toBe(true);
    expect(cohort.slice(0, 6).every((c) => c.fragilityFlag === false)).toBe(true);
  });

  it("does not flag 60% of a cohort the way the absolute thresholds did", () => {
    const cohort = Array.from({ length: 30 }, (_, i) => m(0.3 + i * 0.01, 0.7 + i * 0.01)); // every name above the OLD thresholds
    expect(cohort.every((c) => fragilityFlag(c.extensionVs200d, c.vol60d))).toBe(true);
    applyFragilityCohort(cohort);
    expect(cohort.filter((c) => c.fragilityFlag).length).toBe(10);
  });

  it("ties at the cut are all flagged", () => {
    const cohort = [m(1, 1), m(1, 1), m(1, 1), m(1, 1), m(1, 1), m(1, 1)];
    applyFragilityCohort(cohort);
    expect(cohort.every((c) => c.fragilityPercentile === 50)).toBe(true);
    expect(cohort.every((c) => c.fragilityFlag === true)).toBe(true);
  });

  it("uses whichever metric a member has; null when it has neither; those members never take a flag", () => {
    const cohort = [m(0.1, null), m(0.2, null), m(0.3, null), m(null, null)];
    applyFragilityCohort(cohort);
    expect(cohort[2].fragilityPercentile).toBeCloseTo((2.5 / 3) * 100);
    expect(cohort[3].fragilityPercentile).toBeNull();
    expect(cohort[3].fragilityFlag).toBeNull();
    expect(cohort.map((c) => c.fragilityFlag)).toEqual([false, false, true, null]);
  });

  it("small cohorts (< 3 with a percentile) get percentiles but no flag", () => {
    const cohort = [m(0.1, 0.2), m(0.3, 0.4)];
    applyFragilityCohort(cohort);
    expect(cohort.every((c) => c.fragilityPercentile != null)).toBe(true);
    expect(cohort.every((c) => c.fragilityFlag === null)).toBe(true);
    const empty: Member[] = [];
    expect(applyFragilityCohort(empty)).toEqual([]);
  });

  it("never changes the raw extension/vol values", () => {
    const cohort = [m(0.5, 0.9), m(0.1, 0.2), m(0.3, 0.4), m(0.2, 0.3)];
    applyFragilityCohort(cohort);
    expect(cohort.map((c) => [c.extensionVs200d, c.vol60d])).toEqual([[0.5, 0.9], [0.1, 0.2], [0.3, 0.4], [0.2, 0.3]]);
  });
});
