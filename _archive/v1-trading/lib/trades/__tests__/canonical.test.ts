import { describe, it, expect } from "vitest";
import { selectCanonicalOpenTrade } from "@/lib/trades/canonical";

describe("selectCanonicalOpenTrade", () => {
  it("prefers AUTO trade over broker_backfill", () => {
    const brokerBackfill = {
      id: "t-bf",
      status: "OPEN",
      ticker: "AAPL",
      source: "broker_backfill",
      entryPrice: 0,
      stopPrice: null,
      openedAt: "2026-02-25T15:30:00.000Z",
    };

    const autoTrade = {
      id: "t-auto",
      status: "OPEN",
      ticker: "AAPL",
      source: "AUTO",
      entryPrice: 157.14,
      stopPrice: 155.57,
      takeProfitPrice: 160.28,
      openedAt: "2026-02-25T15:00:00.000Z",
    };

    const { canonical, duplicates } = selectCanonicalOpenTrade([
      brokerBackfill,
      autoTrade,
    ]);

    expect(canonical.id).toBe("t-auto");
    expect(duplicates.map((d) => d.id)).toEqual(["t-bf"]);
  });

  it("falls back to most recent openedAt when no AUTO and no valid entry/stop", () => {
    const older = {
      id: "t-older",
      status: "OPEN",
      ticker: "MSFT",
      source: "manual",
      entryPrice: 0,
      stopPrice: null,
      openedAt: "2026-02-25T14:00:00.000Z",
    };

    const newer = {
      id: "t-newer",
      status: "OPEN",
      ticker: "MSFT",
      source: "broker_backfill",
      entryPrice: 0,
      stopPrice: null,
      openedAt: "2026-02-25T14:15:00.000Z",
    };

    const { canonical, duplicates } = selectCanonicalOpenTrade([older, newer]);

    expect(canonical.id).toBe("t-newer");
    expect(duplicates.map((d) => d.id)).toEqual(["t-older"]);
  });
});
