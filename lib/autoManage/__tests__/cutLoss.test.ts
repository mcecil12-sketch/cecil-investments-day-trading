import { describe, it, expect } from "vitest";
import { planCanonicalCutLossActions } from "@/lib/autoManage/cutLoss";

describe("planCanonicalCutLossActions", () => {
  it("generates close action for canonical trade only when below threshold", () => {
    const canonicalTrade = {
      id: "t-auto",
      ticker: "AAPL",
      status: "OPEN",
      unrealizedR: -1.2,
    };

    const duplicateTrade = {
      id: "t-dup",
      ticker: "AAPL",
      status: "OPEN",
      unrealizedR: -1.8,
    };

    const actions = planCanonicalCutLossActions({
      enabled: true,
      thresholdR: -1.0,
      canonicalTrade,
      duplicates: [duplicateTrade],
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      tradeId: "t-auto",
      ticker: "AAPL",
      reason: "cut_loss_r",
      rule: "CUT_LOSS_R",
      r: -1.2,
    });
    expect(actions.some((a) => a.tradeId === "t-dup")).toBe(false);
  });
});
