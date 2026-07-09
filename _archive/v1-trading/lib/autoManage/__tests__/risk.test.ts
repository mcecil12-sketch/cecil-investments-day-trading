import { describe, expect, it } from "vitest";
import { computeUnrealizedR, decideReplacement } from "@/lib/autoManage/risk";

describe("computeUnrealizedR", () => {
  it("computes LONG R", () => {
    const r = computeUnrealizedR({
      side: "LONG",
      qty: 10,
      entryPrice: 100,
      stopPrice: 98,
      currentPrice: 103,
    });
    expect(r).toBeCloseTo(1.5, 6);
  });

  it("computes SHORT R", () => {
    const r = computeUnrealizedR({
      side: "SHORT",
      qty: 10,
      entryPrice: 100,
      stopPrice: 102,
      currentPrice: 97,
    });
    expect(r).toBeCloseTo(1.5, 6);
  });

  it("returns null for invalid inputs", () => {
    expect(
      computeUnrealizedR({
        side: "LONG",
        qty: null,
        entryPrice: 100,
        stopPrice: 98,
        currentPrice: 101,
      })
    ).toBeNull();

    expect(
      computeUnrealizedR({
        side: "LONG",
        qty: 10,
        entryPrice: 100,
        stopPrice: 100,
        currentPrice: 101,
      })
    ).toBeNull();

    expect(
      computeUnrealizedR({
        side: "LONG",
        qty: 10,
        entryPrice: 100,
        stopPrice: 98,
        currentPrice: null,
      })
    ).toBeNull();
  });
});

describe("decideReplacement", () => {
  it("skips replacement when unrealizedR is null by default", () => {
    const decision = decideReplacement({
      openUnrealizedR: null,
      openScore: 2.0,
      candidateScore: 4.0,
      allowUnknownROverride: false,
      overrideScoreDelta: 1.5,
    });

    expect(decision.execute).toBe(false);
    expect(decision.reason).toBe("replace_skip_r_unknown");
  });

  it("allows override for unknown R when score delta is large", () => {
    const decision = decideReplacement({
      openUnrealizedR: null,
      openScore: 2.0,
      candidateScore: 4.0,
      allowUnknownROverride: true,
      overrideScoreDelta: 1.5,
    });

    expect(decision.execute).toBe(true);
    expect(decision.reason).toBe("replace_execute");
  });

  it("skips replacement when unrealizedR is positive", () => {
    const decision = decideReplacement({
      openUnrealizedR: 0.8,
      openScore: 2.0,
      candidateScore: 6.0,
      allowUnknownROverride: true,
      overrideScoreDelta: 1.5,
    });

    expect(decision.execute).toBe(false);
    expect(decision.reason).toBe("replace_skip_r_positive");
  });
});
