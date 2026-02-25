import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAutoEntryOnce } from "@/lib/autoEntry/engine";

vi.mock("@/lib/tradesStore", () => ({
  readTrades: vi.fn(),
}));

vi.mock("@/lib/alpacaClock", () => ({
  fetchAlpacaClock: vi.fn(),
}));

vi.mock("@/lib/alpaca", () => ({
  alpacaRequest: vi.fn(),
}));

import { readTrades } from "@/lib/tradesStore";
import { fetchAlpacaClock } from "@/lib/alpacaClock";
import { alpacaRequest } from "@/lib/alpaca";

describe("runAutoEntryOnce diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTO_TRADING_ENABLED = "1";
    process.env.AUTO_TRADING_PAPER_ONLY = "1";
    process.env.AUTO_ENTRY_TOKEN = "test-token";
    process.env.AUTO_ENTRY_MAX_OPEN = "10";
    process.env.AUTO_ENTRY_MAX_PER_DAY = "10";
    process.env.AUTO_PENDING_MAX_AGE_HOURS = "48";

    vi.mocked(fetchAlpacaClock).mockResolvedValue({ is_open: false, timestamp: "2026-02-25T15:00:00Z" } as any);
    vi.mocked(alpacaRequest).mockResolvedValue({ ok: true, status: 200, text: "[]" });
  });

  it("selects newest canonical pending per ticker and counts duplicate_ticker skip", async () => {
    vi.mocked(readTrades).mockResolvedValue([
      {
        id: "old-aeis",
        ticker: "AEIS",
        side: "SHORT",
        status: "AUTO_PENDING",
        source: "AUTO",
        entryPrice: 100,
        stopPrice: 101,
        takeProfitPrice: 98,
        createdAt: "2026-02-25T10:00:00Z",
      },
      {
        id: "new-aeis",
        ticker: "AEIS",
        side: "SHORT",
        status: "AUTO_PENDING",
        source: "AUTO",
        entryPrice: 100,
        stopPrice: 101,
        takeProfitPrice: 98,
        createdAt: "2026-02-25T11:00:00Z",
      },
      {
        id: "qqq",
        ticker: "QQQ",
        side: "LONG",
        status: "AUTO_PENDING",
        source: "AUTO",
        entryPrice: 500,
        stopPrice: 495,
        takeProfitPrice: 510,
        createdAt: "2026-02-25T12:00:00Z",
      },
    ] as any);

    const req = new Request("http://localhost/api/auto-entry/run?dryRun=1", {
      method: "POST",
      headers: { "x-auto-entry-token": "test-token" },
    });

    const result: any = await runAutoEntryOnce(req);

    expect(result.ok).toBe(true);
    expect(result.pendingCount).toBe(3);
    expect(result.eligibleCount).toBe(2);
    expect(result.skipsByReason.duplicate_ticker).toBe(1);

    const duplicateAction = result.actions.find((a: any) => a.id === "old-aeis");
    expect(duplicateAction?.decision).toBe("SKIP");
    expect(duplicateAction?.reason).toBe("duplicate_ticker");

    const canonicalAction = result.actions.find((a: any) => a.id === "new-aeis");
    expect(canonicalAction?.decision).toBe("WOULD_EXECUTE");
  });

  it("returns diagnostics in dryRun when market is closed", async () => {
    vi.mocked(readTrades).mockResolvedValue([
      {
        id: "pending-1",
        ticker: "TQQQ",
        side: "LONG",
        status: "AUTO_PENDING",
        source: "AUTO",
        entryPrice: 70,
        stopPrice: 68,
        takeProfitPrice: 74,
        createdAt: "2026-02-25T12:00:00Z",
      },
    ] as any);

    const req = new Request("http://localhost/api/auto-entry/run?dryRun=1", {
      method: "POST",
      headers: { "x-auto-entry-token": "test-token" },
    });

    const result: any = await runAutoEntryOnce(req);

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.market.isOpen).toBe(false);
    expect(result.pendingCount).toBeGreaterThan(0);
    expect(result.eligibleCount).toBeGreaterThanOrEqual(0);
    expect(result.pendingSample.length).toBe(1);
    expect(result.skipsByReason.market_closed).toBe(1);

    expect(result.actions[0]).toMatchObject({
      id: "pending-1",
      decision: "WOULD_EXECUTE",
      reason: "market_closed",
    });
  });

  it("counts guardrail skip reasons", async () => {
    process.env.AUTO_ENTRY_MAX_OPEN = "0";
    vi.mocked(fetchAlpacaClock).mockResolvedValue({ is_open: true, timestamp: "2026-02-25T15:00:00Z" } as any);

    vi.mocked(readTrades).mockResolvedValue([
      {
        id: "open-1",
        ticker: "SPY",
        side: "LONG",
        status: "OPEN",
        source: "AUTO",
        createdAt: "2026-02-25T10:00:00Z",
      },
      {
        id: "pending-2",
        ticker: "IWM",
        side: "LONG",
        status: "AUTO_PENDING",
        source: "AUTO",
        entryPrice: 200,
        stopPrice: 198,
        takeProfitPrice: 204,
        createdAt: "2026-02-25T12:00:00Z",
      },
    ] as any);

    const req = new Request("http://localhost/api/auto-entry/run?dryRun=1", {
      method: "POST",
      headers: { "x-auto-entry-token": "test-token" },
    });

    const result: any = await runAutoEntryOnce(req);

    expect(result.skipsByReason.max_open_positions).toBe(1);
    const blocked = result.actions.find((a: any) => a.id === "pending-2");
    expect(blocked?.decision).toBe("SKIP");
    expect(blocked?.reason).toBe("max_open_positions");
  });
});
