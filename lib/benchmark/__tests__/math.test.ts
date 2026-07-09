import { describe, expect, it } from "vitest";
import { computeAlpha, computeReturn, subtractYears } from "@/lib/benchmark/math";

describe("subtractYears", () => {
  it("subtracts calendar years in UTC", () => {
    const result = subtractYears(new Date("2026-07-09T00:00:00.000Z"), 3);
    expect(result.toISOString()).toBe("2023-07-09T00:00:00.000Z");
  });

  it("handles leap-day gracefully", () => {
    const result = subtractYears(new Date("2024-02-29T00:00:00.000Z"), 1);
    // JS Date rolls Feb 29 in a non-leap target year to Mar 1 — acceptable,
    // just document the behavior so a future change doesn't go unnoticed.
    expect(result.toISOString()).toBe("2023-03-01T00:00:00.000Z");
  });
});

describe("computeReturn", () => {
  it("computes a simple NAV-delta return", () => {
    expect(computeReturn(100, 120)).toBeCloseTo(0.2);
    expect(computeReturn(100, 80)).toBeCloseTo(-0.2);
  });

  it("returns null for a zero or non-finite start value", () => {
    expect(computeReturn(0, 120)).toBeNull();
    expect(computeReturn(Number.NaN, 120)).toBeNull();
  });
});

describe("computeAlpha", () => {
  it("is portfolio return minus S&P 500 return", () => {
    expect(computeAlpha(0.12, 0.08)).toBeCloseTo(0.04);
  });

  it("propagates null when either input is missing", () => {
    expect(computeAlpha(null, 0.08)).toBeNull();
    expect(computeAlpha(0.12, null)).toBeNull();
  });
});
