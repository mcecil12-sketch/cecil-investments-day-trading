import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const computeOperationalDiagnostics = vi.fn(() => ({
    brokerPositionsCount: 0,
    dbOpenTradesCount: 0,
    dbAutoOpenTradesCount: 8,
    dbActualOperationalCount: 0,
    openTradesMismatch: false,
    mismatchNote: null,
  }));

  return {
    computeOperationalDiagnostics,
  };
});

vi.mock("@/lib/alpacaClock", () => ({
  fetchAlpacaClock: vi.fn(async () => ({ is_open: true })),
}));

vi.mock("@/lib/funnelRedis", () => ({
  readTodayFunnel: vi.fn(async () => ({ lastScanAt: new Date().toISOString() })),
}));

vi.mock("@/lib/jsonDb", () => ({
  readSignals: vi.fn(async () => []),
}));

vi.mock("@/lib/autoEntry/guardrails", () => ({
  getGuardrailConfig: vi.fn(() => ({})),
}));

vi.mock("@/lib/autoEntry/guardrailsStore", () => ({
  getGuardrailsState: vi.fn(async () => ({ autoDisabledReason: null })),
  getAutoEntryEnabledState: vi.fn(async () => ({ enabled: true, reason: null })),
}));

vi.mock("@/lib/broker/truth", () => ({
  fetchBrokerTruth: vi.fn(async () => ({ positionsCount: 0, positions: [], error: null })),
}));

vi.mock("@/lib/tradesStore", () => ({
  readTrades: vi.fn(async () => [{ id: "t1", status: "ARCHIVED", source: "AUTO_ENTRY" }]),
}));

vi.mock("@/lib/ops/operationalDiagnostics", () => ({
  computeOperationalDiagnostics: mocks.computeOperationalDiagnostics,
}));

import { readAgentTelemetrySnapshot } from "@/lib/agents/sources";

describe("readAgentTelemetrySnapshot operational truth parity", () => {
  it("uses shared operational diagnostics helper output as authoritative mismatch signal", async () => {
    const telemetry = await readAgentTelemetrySnapshot();

    expect(mocks.computeOperationalDiagnostics).toHaveBeenCalledTimes(1);
    expect(telemetry.openTradeMismatch).toBe(false);
    expect(telemetry.brokerPositionsCount).toBe(0);
    expect(telemetry.dbOpenTradesCount).toBe(0);
    expect(telemetry.dbAutoOpenTradesCount).toBe(8);
    expect(telemetry.dbActualOperationalCount).toBe(0);
    expect(telemetry.dbOperationalOpenCount).toBe(0);
    expect(telemetry.mismatchNote).toBeNull();
  });
});
