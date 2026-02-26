import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tradesStore", () => ({
  readTrades: vi.fn(async () => []),
  writeTrades: vi.fn(async () => undefined),
}));

vi.mock("@/lib/alpaca", () => ({
  alpacaRequest: vi.fn(),
  createOrder: vi.fn(),
}));

vi.mock("@/lib/redis", () => ({
  redis: null,
}));

vi.mock("@/lib/autoEntry/telemetry", () => ({
  recordAutoEntryTelemetry: vi.fn(async () => undefined),
}));

vi.mock("@/lib/auth", () => ({
  requireAuth: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/autoEntry/guardrails", () => ({
  getGuardrailConfig: vi.fn(() => ({
    maxOpenPositions: 10,
    maxEntriesPerDay: 10,
    cooldownAfterLossMin: 30,
    tickerCooldownMin: 15,
    maxConsecutiveFailures: 3,
  })),
  minutesSince: vi.fn(() => null),
}));

vi.mock("@/lib/autoEntry/config", () => ({
  getAutoConfig: vi.fn(() => ({
    enabled: true,
    paperOnly: true,
    token: "",
    baseRiskDollars: 100,
  })),
  tierForScore: vi.fn(() => "B"),
  riskMultForTier: vi.fn(() => 1),
}));

vi.mock("@/lib/autoEntry/pricing", () => ({
  resolveDecisionPrice: vi.fn(() => ({ decisionPrice: 100, source: "entry" })),
  computeBracket: vi.fn(),
}));

vi.mock("@/lib/locks", () => ({
  withRedisLock: vi.fn(),
}));

vi.mock("@/lib/alpacaClock", () => ({
  fetchAlpacaClock: vi.fn(async () => ({ is_open: false, timestamp: "2026-02-26T12:00:00.000Z" })),
}));

vi.mock("@/lib/autoEntry/guardrailsStore", () => ({
  getGuardrailStateKey: vi.fn(() => "guard:2026-02-26"),
  getGuardrailsState: vi.fn(async () => ({
    entriesToday: 0,
    consecutiveFailures: 0,
    autoDisabledReason: null,
    lastLossAt: null,
    tickerEntries: {},
  })),
  getAutoEntryEnabledState: vi.fn(async () => ({ enabled: true, reason: null })),
  recordFailure: vi.fn(async () => 1),
  setAutoDisabled: vi.fn(async () => undefined),
  resetFailures: vi.fn(async () => undefined),
  clearAutoDisabled: vi.fn(async () => undefined),
  bumpEntry: vi.fn(async () => undefined),
}));

vi.mock("@/lib/notifications/notify", () => ({
  sendNotification: vi.fn(async () => undefined),
}));

vi.mock("@/lib/tickSize", () => ({
  normalizeStopPrice: vi.fn(() => ({ ok: true, stop: 99 })),
  normalizeLimitPrice: vi.fn(({ price }) => price),
  tickForEquityPrice: vi.fn(() => 0.01),
}));

vi.mock("@/lib/broker/truth", () => ({
  fetchBrokerTruth: vi.fn(async () => ({ positionsCount: 0, openOrdersCount: 0 })),
}));

vi.mock("@/lib/autoEntry/eligibility", () => ({
  deriveSessionMeta: vi.fn(() => ({ etDate: "2026-02-26", sessionTag: "PRE" })),
  evaluatePendingEligibility: vi.fn(() => ({ eligible: true })),
  getTradeTimestamp: vi.fn(() => new Date().toISOString()),
}));

vi.mock("@/lib/aiScoring", () => ({
  scoreSignalWithAI: vi.fn(),
}));

vi.mock("@/lib/autoEntry/breaker", () => ({
  evaluateBreakerTransition: vi.fn(() => ({
    consecutiveFailuresBefore: 0,
    consecutiveFailuresAfter: 0,
    breakerAction: "none",
    clearAutoDisabled: false,
  })),
}));

vi.mock("@/lib/time/etDate", () => ({
  getEtDateString: vi.fn(() => "2026-02-26"),
}));

vi.mock("@/lib/autoEntry/disabledNotification", () => ({
  buildAutoEntryDisabledNotificationEvent: vi.fn(),
  notificationEnv: vi.fn(() => "test"),
  shouldSendAutoEntryDisabledNotification: vi.fn(() => false),
}));

vi.mock("@/lib/funnelRedis", () => ({
  bumpTodayFunnel: vi.fn(async () => undefined),
}));

import { recordAutoEntryTelemetry } from "@/lib/autoEntry/telemetry";
import { bumpTodayFunnel } from "@/lib/funnelRedis";
import { POST } from "../route";
import { buildAutoEntryFunnelFields } from "../funnel";

describe("POST /api/auto-entry/execute funnel + run metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps SUCCESS placed and SKIP market_closed to expected funnel counters", () => {
    expect(buildAutoEntryFunnelFields({ outcome: "SUCCESS", reason: "placed" })).toEqual({
      autoEntryPlaced: 1,
    });
    expect(buildAutoEntryFunnelFields({ outcome: "SKIP", reason: "market_closed" })).toEqual({
      autoEntrySkipMarketClosed: 1,
    });
  });

  it("bumps execute + market_closed skip counters and writes non-empty runId/source for cookie auth", async () => {
    const req = new Request("http://localhost/api/auto-entry/execute", { method: "POST" });

    const res = await POST(req);
    const body: any = await res.json();

    expect(body.ok).toBe(true);
    expect(body.reason).toBe("market_closed");

    expect(vi.mocked(bumpTodayFunnel)).toHaveBeenCalledWith({ autoEntryExecutes: 1 });
    expect(vi.mocked(bumpTodayFunnel)).toHaveBeenCalledWith({ autoEntrySkipMarketClosed: 1 });

    expect(vi.mocked(recordAutoEntryTelemetry)).toHaveBeenCalledTimes(1);
    const telemetryEvent = vi.mocked(recordAutoEntryTelemetry).mock.calls[0][0] as any;
    expect(telemetryEvent.source).toBe("terminal");
    expect(typeof telemetryEvent.runId).toBe("string");
    expect(telemetryEvent.runId.length).toBeGreaterThan(0);
    expect(telemetryEvent.runId.startsWith("ae-exec-")).toBe(true);
  });
});
