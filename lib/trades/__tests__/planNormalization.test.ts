import { describe, expect, it } from "vitest";
import { isTradePlanSideValid, normalizeTradePlanForSide } from "@/lib/trades/planNormalization";

describe("planNormalization", () => {
  it("accepts valid LONG plan", () => {
    const result = normalizeTradePlanForSide({
      side: "LONG",
      entryPrice: 100,
      stopPrice: 98,
      targetPrice: 104,
    });

    expect(result.ok).toBe(true);
    expect(result.normalizedForSide).toBe(false);
    expect(isTradePlanSideValid("LONG", result.normalizedEntryPrice, result.normalizedStopPrice, result.normalizedTargetPrice)).toBe(true);
  });

  it("accepts valid SHORT plan", () => {
    const result = normalizeTradePlanForSide({
      side: "SHORT",
      entryPrice: 100,
      stopPrice: 102,
      targetPrice: 96,
    });

    expect(result.ok).toBe(true);
    expect(result.normalizedForSide).toBe(false);
    expect(isTradePlanSideValid("SHORT", result.normalizedEntryPrice, result.normalizedStopPrice, result.normalizedTargetPrice)).toBe(true);
  });

  it("inverts long-style plan when side is SHORT", () => {
    const result = normalizeTradePlanForSide({
      side: "SHORT",
      entryPrice: 5.9816,
      stopPrice: 5.921784,
      targetPrice: 6.101232,
    });

    expect(result.ok).toBe(true);
    expect(result.normalizedForSide).toBe(true);
    expect(result.normalizedStopPrice).toBeGreaterThan(result.normalizedEntryPrice);
    expect(result.normalizedTargetPrice).toBeLessThan(result.normalizedEntryPrice);
    expect(result.rewardMultipleUsed).toBeCloseTo(2, 6);
  });

  it("rejects malformed one-sided SHORT plan", () => {
    const result = normalizeTradePlanForSide({
      side: "SHORT",
      entryPrice: 50,
      stopPrice: 55,
      targetPrice: 52,
    });

    expect(result.ok).toBe(false);
    expect(result.invalidReason).toBe("invalid_trade_plan_for_side");
  });
});
