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

vi.mock("@/lib/aiScoring", () => ({
  scoreSignalWithAI: vi.fn(),
}));

import { readTrades } from "@/lib/tradesStore";
import { fetchAlpacaClock } from "@/lib/alpacaClock";
import { alpacaRequest } from "@/lib/alpaca";
import { scoreSignalWithAI } from "@/lib/aiScoring";

function isoMinutesAgo(mins: number) {
  return new Date(Date.now() - mins * 60_000).toISOString();
}

let CURRENT_ET_DATE = "";
let CURRENT_SESSION_TAG = "CLOSED";

function deriveSessionFromIso(iso: string) {
  const d = new Date(iso);
  const etDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
  const hm = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d).split(":");
  const hour = Number(hm[0] || 0);
  const minute = Number(hm[1] || 0);
  const mins = hour * 60 + minute;
  const sessionTag = mins >= 240 && mins < 570 ? "PRE" : mins >= 570 && mins < 960 ? "RTH" : mins >= 960 && mins < 1200 ? "POST" : "CLOSED";
  return { etDate, sessionTag };
}

describe("runAutoEntryOnce diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTO_TRADING_ENABLED = "1";
    process.env.AUTO_TRADING_PAPER_ONLY = "1";
    process.env.AUTO_ENTRY_TOKEN = "test-token";
    process.env.AUTO_ENTRY_MAX_OPEN = "10";
    process.env.AUTO_ENTRY_MAX_PER_DAY = "10";
    process.env.AUTO_ENTRY_MAX_AGE_MIN = "15";
    process.env.AUTO_ENTRY_RESCORE_AFTER_MIN = "10";
    process.env.AUTO_ENTRY_BLOCK_CARRYOVER = "1";

    const clockTs = new Date().toISOString();
    const session = deriveSessionFromIso(clockTs);
    CURRENT_ET_DATE = session.etDate;
    CURRENT_SESSION_TAG = session.sessionTag;
    vi.mocked(fetchAlpacaClock).mockResolvedValue({ is_open: false, timestamp: clockTs } as any);
    vi.mocked(alpacaRequest).mockResolvedValue({ ok: true, status: 200, text: "[]" });
    vi.mocked(scoreSignalWithAI).mockResolvedValue({
      ok: true,
      scored: {
        aiScore: 8.2,
        qualified: true,
        bestDirection: "LONG",
        entryPrice: 100,
        stopPrice: 98,
        targetPrice: 104,
      },
    } as any);
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
        createdAt: isoMinutesAgo(8),
        scoredAt: isoMinutesAgo(8),
        etDate: CURRENT_ET_DATE,
        sessionTag: CURRENT_SESSION_TAG,
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
        createdAt: isoMinutesAgo(5),
        scoredAt: isoMinutesAgo(5),
        etDate: CURRENT_ET_DATE,
        sessionTag: CURRENT_SESSION_TAG,
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
        createdAt: isoMinutesAgo(4),
        scoredAt: isoMinutesAgo(4),
        etDate: CURRENT_ET_DATE,
        sessionTag: CURRENT_SESSION_TAG,
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
        createdAt: isoMinutesAgo(10),
        scoredAt: isoMinutesAgo(10),
        etDate: CURRENT_ET_DATE,
        sessionTag: CURRENT_SESSION_TAG,
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
    const clockTs = new Date().toISOString();
    vi.mocked(fetchAlpacaClock).mockResolvedValue({ is_open: true, timestamp: clockTs } as any);

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
        createdAt: isoMinutesAgo(10),
        scoredAt: isoMinutesAgo(10),
        etDate: CURRENT_ET_DATE,
        sessionTag: CURRENT_SESSION_TAG,
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

  it("applies age windows: <=10 eligible, >10<=15 rescore, >15 stale", async () => {
    vi.mocked(readTrades).mockResolvedValue([
      {
        id: "age-10",
        ticker: "AAPL",
        side: "LONG",
        status: "AUTO_PENDING",
        source: "AUTO",
        entryPrice: 100,
        stopPrice: 98,
        takeProfitPrice: 104,
        createdAt: isoMinutesAgo(10),
        scoredAt: isoMinutesAgo(10),
        etDate: CURRENT_ET_DATE,
        sessionTag: CURRENT_SESSION_TAG,
      },
      {
        id: "age-12",
        ticker: "MSFT",
        side: "LONG",
        status: "AUTO_PENDING",
        source: "AUTO",
        entryPrice: 100,
        stopPrice: 98,
        takeProfitPrice: 104,
        createdAt: isoMinutesAgo(12),
        scoredAt: isoMinutesAgo(12),
        etDate: CURRENT_ET_DATE,
        sessionTag: CURRENT_SESSION_TAG,
      },
      {
        id: "age-20",
        ticker: "NVDA",
        side: "LONG",
        status: "AUTO_PENDING",
        source: "AUTO",
        entryPrice: 100,
        stopPrice: 98,
        takeProfitPrice: 104,
        createdAt: isoMinutesAgo(20),
        scoredAt: isoMinutesAgo(20),
        etDate: CURRENT_ET_DATE,
        sessionTag: CURRENT_SESSION_TAG,
      },
    ] as any);

    const req = new Request("http://localhost/api/auto-entry/run?dryRun=1", {
      method: "POST",
      headers: { "x-auto-entry-token": "test-token" },
    });

    const result: any = await runAutoEntryOnce(req);

    expect(result.actions.find((a: any) => a.id === "age-10")?.decision).toBe("WOULD_EXECUTE");
    expect(result.actions.find((a: any) => a.id === "age-12")?.decision).toBe("WOULD_EXECUTE");
    expect(result.actions.find((a: any) => a.id === "age-20")?.reason).toBe("stale_trade");
    expect(vi.mocked(scoreSignalWithAI)).toHaveBeenCalledTimes(1);
  });

  it("skips carryover_session for prior market date", async () => {
    vi.mocked(readTrades).mockResolvedValue([
      {
        id: "stale-session",
        ticker: "TSLA",
        side: "LONG",
        status: "AUTO_PENDING",
        source: "AUTO",
        entryPrice: 200,
        stopPrice: 196,
        takeProfitPrice: 208,
        createdAt: isoMinutesAgo(8),
        scoredAt: isoMinutesAgo(8),
        etDate: "1999-01-01",
        sessionTag: CURRENT_SESSION_TAG === "RTH" ? "PRE" : "RTH",
      },
    ] as any);

    const req = new Request("http://localhost/api/auto-entry/run?dryRun=1", {
      method: "POST",
      headers: { "x-auto-entry-token": "test-token" },
    });

    const result: any = await runAutoEntryOnce(req);

    const action = result.actions.find((a: any) => a.id === "stale-session");
    expect(action?.decision).toBe("SKIP");
    expect(action?.reason).toBe("carryover_session");
  });
});

