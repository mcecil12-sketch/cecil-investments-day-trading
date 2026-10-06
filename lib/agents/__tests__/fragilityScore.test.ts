import { describe, expect, it } from "vitest";
import {
  FRAGILITY_EXTENSION_THRESHOLD,
  FRAGILITY_VOL_THRESHOLD,
  betaVsSpx,
  computeFragility,
  extensionVs200d,
  fragilityFlag,
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
    expect(computeFragility(flat(10))).toEqual({ extensionVs200d: null, vol60d: null, fragilityFlag: null });
    expect(computeFragility(null as unknown as PricePoint[])).toEqual({ extensionVs200d: null, vol60d: null, fragilityFlag: null });
  });
  it("vol-only flag with 60-199 bars", () => {
    const closes = [100];
    for (let i = 1; i < 100; i++) closes.push(closes[i - 1] * Math.exp(i % 2 ? 0.06 : -0.06));
    const m = computeFragility(series(closes));
    expect(m.extensionVs200d).toBeNull();
    expect(m.fragilityFlag).toBe(true);
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
