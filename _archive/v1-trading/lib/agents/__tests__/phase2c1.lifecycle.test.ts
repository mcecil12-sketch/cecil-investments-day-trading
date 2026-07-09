import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const mem = new Map<string, string>();
  const redis = {
    get: vi.fn(async (key: string) => mem.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      mem.set(key, value);
      return "OK";
    }),
  };

  const readAgentTelemetrySnapshot = vi.fn();
  const executeRemediationForIncident = vi.fn();
  const isRemediationOnCooldown = vi.fn(() => false);

  return {
    mem,
    redis,
    readAgentTelemetrySnapshot,
    executeRemediationForIncident,
    isRemediationOnCooldown,
  };
});

vi.mock("@/lib/redis", () => ({ redis: mocks.redis }));

vi.mock("@/lib/redis/ttl", () => ({
  getTtlSeconds: vi.fn(() => 3600),
  setWithTtl: vi.fn(async (_r: unknown, key: string, value: string) => {
    mocks.mem.set(key, value);
    return true;
  }),
}));

vi.mock("@/lib/tradingConfig", () => ({
  getTradingConfig: vi.fn(() => ({ flags: { allowTierCAutoEntry: true } })),
}));

vi.mock("@/lib/agents/sources", () => ({
  readAgentTelemetrySnapshot: mocks.readAgentTelemetrySnapshot,
}));

vi.mock("@/lib/agents/remediation", () => ({
  executeRemediationForIncident: mocks.executeRemediationForIncident,
  isRemediationOnCooldown: mocks.isRemediationOnCooldown,
}));

import { runOpsAgent } from "@/lib/agents/runners/ops";
import { runPmAgent } from "@/lib/agents/runners/pm";
import { runRiskAgent } from "@/lib/agents/runners/risk";
import { runEngineeringAgent } from "@/lib/agents/runners/engineering";
import {
  appendEngineeringTask,
  createDefaultAgentState,
  listEngineeringTasks,
  listOpenIncidents,
  readAgentState,
  upsertIncident,
  writeAgentState,
} from "@/lib/agents/store";

function makeTelemetry(overrides: Record<string, unknown> = {}) {
  return {
    nowIso: new Date().toISOString(),
    etDate: "2026-04-05",
    marketOpen: true,
    readinessReady: true,
    readinessReasons: [],
    staleScoring: false,
    staleScanner: false,
    autoEntryDisabled: false,
    autoEntryDisableReason: null,
    openTradeMismatch: false,
    brokerPositionsCount: 0,
    dbOpenTradesCount: 0,
    dbAutoOpenTradesCount: 8,
    dbActualOperationalCount: 0,
    dbOperationalOpenCount: 0,
    mismatchNote: null,
    signalsPendingCount: 0,
    signalsScoredCount: 0,
    zeroScoreCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.mem.clear();
  vi.clearAllMocks();
  mocks.isRemediationOnCooldown.mockReturnValue(false);
  mocks.executeRemediationForIncident.mockResolvedValue({
    attempted: false,
    success: false,
    summary: "noop",
    detail: {},
    error: null,
  });
});

describe("Phase 2C.1 false-positive BROKER_SYNC lifecycle", () => {
  it("does not create BROKER_SYNC incident when auto-open>0 but actual operational mismatch is false", async () => {
    mocks.readAgentTelemetrySnapshot.mockResolvedValueOnce(
      makeTelemetry({
        openTradeMismatch: false,
        brokerPositionsCount: 0,
        dbAutoOpenTradesCount: 8,
        dbActualOperationalCount: 0,
        readinessReady: true,
        readinessReasons: [],
      }),
    );

    await runOpsAgent();

    const openIncidents = await listOpenIncidents(50);
    expect(openIncidents.find((inc) => inc.category === "BROKER_SYNC")).toBeUndefined();
  });

  it("resolves existing BROKER_SYNC incident when operational mismatch is false", async () => {
    await upsertIncident({
      severity: "MEDIUM",
      source: "ops",
      category: "BROKER_SYNC",
      title: "Open trade mismatch",
      summary: "Broker positions=0, DB actual operational open=3.",
      notes: [],
    });

    mocks.readAgentTelemetrySnapshot.mockResolvedValueOnce(
      makeTelemetry({ openTradeMismatch: false, brokerPositionsCount: 0, dbActualOperationalCount: 0 }),
    );

    await runOpsAgent();

    const openIncidents = await listOpenIncidents(50);
    expect(openIncidents.find((inc) => inc.category === "BROKER_SYNC")).toBeUndefined();
  });

  it("PM/Risk normalize when mismatch-driven pressure is gone", async () => {
    const now = new Date().toISOString();
    await writeAgentState({
      ...createDefaultAgentState(now),
      posture: "DEFENSIVE",
      allowedGrades: ["A", "B"],
      minScoreAdjustment: 0.5,
      activeRestrictions: ["PM: open-trade mismatch broker=0 db=8", "Risk tightened to A/B only"],
      telemetry: {
        readinessReady: true,
        readinessReasons: [],
        openTradeMismatch: false,
        brokerPositionsCount: 0,
        dbActualOperationalCount: 0,
        dbAutoOpenTradesCount: 8,
      },
      updatedBy: "ops",
    });

    await runPmAgent();
    await runRiskAgent();

    const state = await readAgentState();
    expect(state.posture).toBe("NORMAL");
    expect(state.allowedGrades).toEqual(["A", "B", "C"]);
    expect(state.minScoreAdjustment).toBe(0);
    expect(state.activeRestrictions.some((value) => value.includes("mismatch"))).toBe(false);
  });

  it("closes open BROKER_SYNC engineering task when linked incident is resolved", async () => {
    const seeded = await upsertIncident({
      severity: "MEDIUM",
      source: "ops",
      category: "BROKER_SYNC",
      title: "Open trade mismatch",
      summary: "Broker positions=0, DB actual operational open=0.",
      status: "RESOLVED",
      notes: ["False positive resolved"],
    });

    const now = new Date().toISOString();
    await appendEngineeringTask({
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: "OPEN",
      title: "Resolve broker/DB open-trade mismatch for stale OPEN trades",
      summary: "False-positive mismatch follow-up",
      likelyFiles: ["lib/agents/sources.ts"],
      copilotPrompt: "Investigate mismatch",
      smokeTestBlock: "npm run test",
      gitBlock: "git add -A",
      incidentId: seeded.incident.id,
      incidentCategory: "BROKER_SYNC",
      remediationAttempted: false,
      remediationStatus: "none",
    });

    await runEngineeringAgent();

    const tasks = await listEngineeringTasks(50);
    const linked = tasks.find((task) => task.incidentId === seeded.incident.id);
    expect(linked?.status).toBe("DONE");
  });
});
