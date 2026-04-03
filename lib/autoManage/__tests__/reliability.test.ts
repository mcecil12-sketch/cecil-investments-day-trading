import { describe, expect, it } from "vitest";
import { planConservativeReplacement } from "@/lib/autoManage/reliability";

const baseConfig = {
  thresholdScoreDelta: 1.5,
  minAgeMin: 10,
  protectWinnerAboveR: 0.25,
  allowUnknownROverride: false,
};

describe("planConservativeReplacement", () => {
  it("does not consider replacement when capacity is available", () => {
    const decision = planConservativeReplacement({
      incomingTrade: { id: "in-1", ticker: "NVDA", aiScore: 7.5 },
      openTrades: [],
      brokerPositionsBySymbol: new Map(),
      openOrdersBySymbol: new Map(),
      nowIso: "2026-04-03T14:30:00.000Z",
      marketClosed: false,
      staleAfterEt: "23:59",
      eodFlattenEnabled: true,
      maxOpenReached: false,
      config: baseConfig,
    });

    expect(decision.replacementConsidered).toBe(false);
    expect(decision.replacementExecuted).toBe(false);
    expect(decision.replacementReason).toBe("capacity_available");
  });

  it("skips replacement when score delta is too small", () => {
    const decision = planConservativeReplacement({
      incomingTrade: { id: "in-2", ticker: "MSFT", aiScore: 6.2, createdAt: "2026-04-03T14:31:00.000Z" },
      openTrades: [
        {
          id: "open-1",
          ticker: "AAPL",
          side: "LONG",
          status: "OPEN",
          aiScore: 5.4,
          unrealizedR: -0.2,
          openedAt: "2026-04-03T13:00:00.000Z",
        },
      ],
      brokerPositionsBySymbol: new Map([["AAPL", { symbol: "AAPL", qty: 10 }]]),
      openOrdersBySymbol: new Map(),
      nowIso: "2026-04-03T14:32:00.000Z",
      marketClosed: false,
      staleAfterEt: "23:59",
      eodFlattenEnabled: true,
      maxOpenReached: true,
      config: baseConfig,
    });

    expect(decision.replacementConsidered).toBe(true);
    expect(decision.replacementExecuted).toBe(false);
    expect(decision.replacementReason).toBe("score_delta_too_small");
  });

  it("executes replacement for stale losing weakest trade", () => {
    const decision = planConservativeReplacement({
      incomingTrade: { id: "in-3", ticker: "TSLA", aiScore: 6.0, createdAt: "2026-04-03T20:01:00.000Z" },
      openTrades: [
        {
          id: "open-2",
          ticker: "META",
          side: "LONG",
          status: "OPEN",
          aiScore: 5.6,
          unrealizedR: -0.6,
          openedAt: "2026-04-03T14:00:00.000Z",
        },
      ],
      brokerPositionsBySymbol: new Map([["META", { symbol: "META", qty: 7 }]]),
      openOrdersBySymbol: new Map(),
      nowIso: "2026-04-03T20:02:00.000Z",
      marketClosed: true,
      staleAfterEt: "16:05",
      eodFlattenEnabled: true,
      maxOpenReached: true,
      config: baseConfig,
    });

    expect(decision.replacementConsidered).toBe(true);
    expect(decision.replacementExecuted).toBe(true);
    expect(decision.replacementReason).toBe("replacement_execute");
    expect(decision.weakestOpenTradeId).toBe("open-2");
  });

  it("never replaces when incoming ticker already has an open trade", () => {
    const decision = planConservativeReplacement({
      incomingTrade: { id: "in-4", ticker: "AMD", aiScore: 8.1, createdAt: "2026-04-03T15:00:00.000Z" },
      openTrades: [
        {
          id: "open-3",
          ticker: "AMD",
          side: "LONG",
          status: "OPEN",
          aiScore: 3.0,
          unrealizedR: -0.9,
          openedAt: "2026-04-03T12:00:00.000Z",
        },
      ],
      brokerPositionsBySymbol: new Map([["AMD", { symbol: "AMD", qty: 4 }]]),
      openOrdersBySymbol: new Map(),
      nowIso: "2026-04-03T15:01:00.000Z",
      marketClosed: false,
      staleAfterEt: "23:59",
      eodFlattenEnabled: true,
      maxOpenReached: true,
      config: baseConfig,
    });

    expect(decision.replacementConsidered).toBe(true);
    expect(decision.replacementExecuted).toBe(false);
    expect(decision.replacementReason).toBe("same_ticker_already_open");
  });
});
