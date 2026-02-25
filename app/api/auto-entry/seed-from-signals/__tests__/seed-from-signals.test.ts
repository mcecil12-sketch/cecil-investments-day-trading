import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../route";
import * as tradesStore from "@/lib/tradesStore";

vi.mock("@/lib/tradesStore", () => ({
  readTrades: vi.fn(),
  upsertTrade: vi.fn(),
}));

vi.mock("@/lib/autoEntry/config", () => ({
  getAutoConfig: vi.fn(() => ({
    enabled: true,
    allowedTiers: ["A", "B", "C"],
  })),
  tierForScore: vi.fn((score: number) => {
    if (score >= 8.5) return "A";
    if (score >= 7.5) return "B";
    return "C";
  }),
}));

describe("POST /api/auto-entry/seed-from-signals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTO_ENTRY_TOKEN = "test-auto-token";
    process.env.CRON_TOKEN = "test-cron-token";
    process.env.NEXT_PUBLIC_BASE_URL = "http://127.0.0.1:3000";

    vi.mocked(tradesStore.readTrades).mockResolvedValue([] as any);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          signals: [
            {
              id: "sig-1",
              status: "SCORED",
              qualified: true,
              symbol: "AAPL",
              bestDirection: "LONG",
              aiScore: 9.1,
              entryPrice: 100,
              stopPrice: 98,
              targetPrice: 104,
            },
            {
              id: "sig-2",
              status: "SCORED",
              qualified: true,
              ticker: "AAPL",
              direction: "LONG",
              aiScore: 8.9,
              entryPrice: 101,
              stopPrice: 99,
              targetPrice: 105,
            },
            {
              id: "sig-3",
              status: "SCORED",
              qualified: true,
              symbol: "TSLA",
              direction: "SHORT",
              aiScore: 8.8,
              entryPrice: 250,
              stopPrice: 255,
              targetPrice: 240,
            },
            {
              id: "sig-4",
              status: "SCORED",
              qualified: true,
              symbol: "NVDA",
              aiDirection: "LONG",
              aiScore: 8.7,
              entryPrice: 900,
              stopPrice: 885,
              targetPrice: 940,
            },
            {
              id: "sig-5",
              status: "SCORED",
              qualified: true,
              symbol: "NFLX",
              side: "SHORT",
              aiScore: 8.6,
              entryPrice: 500,
              stopPrice: 510,
              targetPrice: 480,
            },
            {
              id: "sig-6",
              status: "SCORED",
              qualified: false,
              symbol: "META",
              bestDirection: "LONG",
              aiScore: 9.2,
              entryPrice: 400,
              stopPrice: 392,
              targetPrice: 416,
            },
            {
              id: "sig-7",
              status: "SCORED",
              qualified: true,
              symbol: "AMD",
              bestDirection: "LONG",
              aiScore: 8.4,
              entryPrice: 180,
              stopPrice: 176,
              targetPrice: 188,
            },
            {
              id: "sig-8",
              status: "SCORED",
              qualified: true,
              symbol: "INTC",
              bestDirection: "LONG",
              aiScore: 8.9,
              entryPrice: 40,
              stopPrice: null,
              targetPrice: 43,
            },
          ],
        }),
      })
    );
  });

  it("dedupes symbol+side, filters invalid/unqualified, derives side fallback, and respects minScore + limit", async () => {
    const req = new NextRequest(
      "http://localhost:3000/api/auto-entry/seed-from-signals?limit=4&minScore=8.5",
      {
        method: "POST",
        headers: {
          "x-auto-entry-token": "test-auto-token",
        },
      }
    );

    const res = await POST(req);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.limit).toBe(4);
    expect(body.minScore).toBe(8.5);
    expect(body.totalSignals).toBe(8);
    expect(body.totalCandidates).toBe(4);
    expect(body.createdCount).toBe(4);

    expect(body.created.map((x: any) => `${x.symbol}:${x.side}`)).toEqual([
      "AAPL:LONG",
      "TSLA:SHORT",
      "NVDA:LONG",
      "NFLX:SHORT",
    ]);

    expect(global.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/api/signals/all?since=48h&onlyActive=1&order=desc&limit=1000&statuses=SCORED",
      { method: "GET", cache: "no-store" }
    );

    const skippedReasons = body.skipped.map((s: any) => s.reason);
    expect(skippedReasons).toContain("duplicate_symbol_side_in_batch");
    expect(skippedReasons).toContain("not_qualified");
    expect(skippedReasons).toContain("below_minScore");
    expect(skippedReasons).toContain("missing_required_prices");

    expect(tradesStore.upsertTrade).toHaveBeenCalledTimes(4);
  });
});
