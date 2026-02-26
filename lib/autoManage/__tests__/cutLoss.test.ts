import { describe, it, expect } from "vitest";
import { planCanonicalCutLossActions } from "@/lib/autoManage/cutLoss";
import { evaluateCutLoss } from "@/lib/autoManage/cutLoss";

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

describe("evaluateCutLoss", () => {
  it("triggers when enabled and unrealizedR <= threshold", () => {
    const res = evaluateCutLoss({
      enabled: true,
      thresholdR: -1,
      trade: {
        id: "t1",
        ticker: "msft",
        status: "OPEN",
        unrealizedR: -1.05,
      },
    });

    expect(res.action).toEqual({
      tradeId: "t1",
      ticker: "MSFT",
      reason: "cut_loss_r",
      rule: "CUT_LOSS_R",
      r: -1.05,
    });
    expect(res.note).toBe("cutloss_trigger:MSFT:r=-1.050");
  });

  it("skips when disabled", () => {
    const res = evaluateCutLoss({
      enabled: false,
      thresholdR: -1,
      trade: {
        id: "t2",
        ticker: "AAPL",
        status: "OPEN",
        unrealizedR: -2,
      },
    });

    expect(res.action).toBeNull();
    expect(res.note).toBe("cutloss_skip_disabled");
  });

  it("skips when R is unknown", () => {
    const res = evaluateCutLoss({
      enabled: true,
      thresholdR: -1,
      trade: {
        id: "t3",
        ticker: "NVDA",
        status: "OPEN",
        unrealizedR: null,
      },
    });

    expect(res.action).toBeNull();
    expect(res.note).toBe("cutloss_skip_r_unknown:NVDA");
  });
});
