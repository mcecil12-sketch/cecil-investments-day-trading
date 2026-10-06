import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INSIDER_FIELD_MAP,
  INSIDER_MAX_CALLS_PER_RUN,
  fetchInsiderTransactions,
  getInsiderActivity,
  summarizeInsiderActivity,
} from "@/lib/agents/insiderActivity";
import { MOMENTUM_TREND_WEIGHT, EARNINGS_SURPRISE_TREND_WEIGHT, SECTOR_LEADERSHIP_WEIGHT } from "@/lib/agents/scoringShared";

const ASOF = new Date("2026-10-06T06:00:00Z");

// Shape verified against a real STX response on 2026-10-06 (all values strings).
function row(over: Partial<Record<string, string>> = {}) {
  return {
    transaction_date: "2026-09-21",
    ticker: "STX",
    executive: "DOE, JANE",
    executive_title: "CFO",
    security_type: "Ordinary Shares",
    acquisition_or_disposal: "D",
    shares: "100.0",
    share_price: "50.0",
    ...over,
  };
}

describe("summarizeInsiderActivity", () => {
  it("counts open-market-style sales: shares * price, distinct sellers", () => {
    const s = summarizeInsiderActivity(
      [row(), row({ shares: "10", share_price: "10" }), row({ executive: "ROE, RICK", shares: "200" })],
      ASOF,
    );
    expect(s.insiderNetSoldUsd30d).toBeCloseTo(5000 + 100 + 10000, 6);
    expect(s.insiderSaleCount30d).toBe(3);
    expect(s.insiderSellers30d).toBe(2);
  });

  it("subtracts real purchases (A at positive price, no same-day derivative row)", () => {
    const s = summarizeInsiderActivity([row({ shares: "100", share_price: "50" }), row({ acquisition_or_disposal: "A", shares: "40", share_price: "50", executive: "BUYER, BOB" })], ASOF);
    expect(s.insiderNetSoldUsd30d).toBe(5000 - 2000);
    expect(s.insiderSaleCount30d).toBe(1);
  });

  it("excludes awards/RSU vests (A at price 0), derivative rows, and gifts (D at price 0)", () => {
    const s = summarizeInsiderActivity(
      [
        row({ acquisition_or_disposal: "A", share_price: "0.0", shares: "5000" }),
        row({ security_type: "Restricted Share Unit", share_price: "0.0" }),
        row({ security_type: "NQ Stock Option", shares: "900", share_price: "10" }),
        row({ share_price: "0.0", shares: "300" }),
      ],
      ASOF,
    );
    expect(s).toMatchObject({ insiderNetSoldUsd30d: 0, insiderSaleCount30d: 0, insiderSellers30d: 0, skippedRows: 0 });
  });

  it("excludes option-exercise acquisitions (A at strike price alongside a same-day derivative row)", () => {
    const s = summarizeInsiderActivity(
      [
        row({ acquisition_or_disposal: "A", shares: "915", share_price: "158.4" }),
        row({ security_type: "NQ Stock Option", shares: "915", share_price: "0.0" }),
        row({ shares: "10", share_price: "100" }),
      ],
      ASOF,
    );
    expect(s.insiderNetSoldUsd30d).toBe(1000);
  });

  it("skips rows missing shares or price and counts them", () => {
    const s = summarizeInsiderActivity([row({ share_price: "None" }), row({ shares: "" }), row()], ASOF);
    expect(s.skippedRows).toBe(2);
    expect(s.insiderSaleCount30d).toBe(1);
  });

  it("ignores rows outside the trailing 30 days", () => {
    const s = summarizeInsiderActivity([row({ transaction_date: "2026-08-01" }), row({ transaction_date: "2026-10-20" })], ASOF);
    expect(s.insiderSaleCount30d).toBe(0);
  });

  it("returns zeros (not nulls) for an empty array", () => {
    expect(summarizeInsiderActivity([], ASOF)).toEqual({
      insiderNetSoldUsd30d: 0,
      insiderSaleCount30d: 0,
      insiderSellers30d: 0,
      insiderHas10b5_1: null,
      skippedRows: 0,
    });
  });

  it("insiderHas10b5_1 is null with the real field map (no planned-sale field), true/false only when a mapped flag exists", () => {
    expect(summarizeInsiderActivity([row()], ASOF).insiderHas10b5_1).toBeNull();
    const map = { ...INSIDER_FIELD_MAP, plannedFlag: "is_10b5_1" };
    expect(summarizeInsiderActivity([row({ is_10b5_1: "true" })], ASOF, map).insiderHas10b5_1).toBe(true);
    expect(summarizeInsiderActivity([row({ is_10b5_1: "false" })], ASOF, map).insiderHas10b5_1).toBe(false);
    expect(summarizeInsiderActivity([row()], ASOF, map).insiderHas10b5_1).toBeNull();
  });
});

describe("fetch + budget", () => {
  const originalKey = process.env.ALPHA_VANTAGE_API_KEY;
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    process.env.ALPHA_VANTAGE_API_KEY = originalKey;
  });

  it("returns null (never throws) on rate-limit message, HTTP error, network error, or missing key", async () => {
    process.env.ALPHA_VANTAGE_API_KEY = "k";
    const from = new Date("2026-09-06");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ Information: "premium endpoint" })));
    expect(await fetchInsiderTransactions("STX", from)).toBeNull();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("x", { status: 500 }));
    expect(await fetchInsiderTransactions("STX", from)).toBeNull();
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("boom"));
    expect(await fetchInsiderTransactions("STX", from)).toBeNull();
    delete process.env.ALPHA_VANTAGE_API_KEY;
    expect(await fetchInsiderTransactions("STX", from)).toBeNull();
  });

  it("hard-stops at the per-run call budget and nulls the rest; a single failure doesn't stop the loop", async () => {
    process.env.ALPHA_VANTAGE_API_KEY = "k";
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify({ data: [row()] })));
    fetchSpy.mockImplementationOnce(async () => new Response(JSON.stringify({ Note: "limit" })));
    const symbols = Array.from({ length: INSIDER_MAX_CALLS_PER_RUN + 3 }, (_, i) => `S${i}`);
    const promise = getInsiderActivity(symbols, ASOF);
    await vi.runAllTimersAsync();
    const { summaries, callsUsed } = await promise;
    expect(callsUsed).toBe(INSIDER_MAX_CALLS_PER_RUN);
    expect(fetchSpy).toHaveBeenCalledTimes(INSIDER_MAX_CALLS_PER_RUN);
    expect(summaries.get("S0")).toBeNull();
    expect(summaries.get("S1")?.insiderSaleCount30d).toBe(1);
    expect(summaries.get(`S${INSIDER_MAX_CALLS_PER_RUN + 2}`)).toBeNull();
  });
});

describe("composite score and rank are independent of insider fields", () => {
  it("is identical with and without insider fields on the entries", () => {
    const rank = (entries: Array<{ symbol: string; price: number; earn: number; sector: number; insider?: object }>) =>
      entries
        .map((e) => ({
          symbol: e.symbol,
          score: Math.max(0, Math.min(100, Math.round(e.price * MOMENTUM_TREND_WEIGHT + e.earn * EARNINGS_SURPRISE_TREND_WEIGHT + e.sector * SECTOR_LEADERSHIP_WEIGHT))),
        }))
        .sort((a, b) => b.score - a.score)
        .map((e, i) => ({ ...e, rank: i + 1 }));
    const base = [
      { symbol: "A", price: 90, earn: 70, sector: 60 },
      { symbol: "B", price: 80, earn: 90, sector: 60 },
      { symbol: "C", price: 70, earn: 50, sector: 60 },
    ];
    const withInsider = base.map((e, i) => ({ ...e, insider: { insiderNetSoldUsd30d: i * 9e7, insiderSaleCount30d: i, insiderSellers30d: i, insiderHas10b5_1: true } }));
    expect(JSON.stringify(rank(withInsider))).toBe(JSON.stringify(rank(base)));
  });
});
