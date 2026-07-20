import { describe, expect, it } from "vitest";
import { computeAlpha, computeReturn } from "@/lib/benchmark/math";

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
