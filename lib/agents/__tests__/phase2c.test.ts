/**
 * Phase 2C regression tests:
 *   - Ops remediation verifies mismatch after reconcile and resolves BROKER_SYNC when cleared
 *   - Ops keeps BROKER_SYNC incident in MONITORING when mismatch persists
 *   - Engineering BROKER_SYNC task is specific and includes success criteria + telemetry snapshot
 *   - Engineering updates existing BROKER_SYNC task with remediation result summary
 */

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
import { runEngineeringAgent } from "@/lib/agents/runners/engineering";
import {
  listAgentActions,
  listEngineeringTasks,
  listOpenIncidents,
  upsertIncident,
  updateIncidentById,
} from "@/lib/agents/store";

function makeTelemetry(overrides: Record<string, unknown> = {}) {
  return {
    readinessReady: true,
    readinessReasons: [],
    signalsPendingCount: 0,
    signalsScoredCount: 0,
    zeroScoreCount: 0,
    staleScanner: false,
    staleScoring: false,
    marketOpen: true,
    autoEntryDisabled: false,
    autoEntryDisableReason: null,
    openTradeMismatch: false,
    brokerPositionsCount: 0,
    dbOperationalOpenCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.mem.clear();
  vi.clearAllMocks();
  mocks.isRemediationOnCooldown.mockReturnValue(false);
});

describe("Phase 2C - ops remediation lifecycle", () => {
  it("resolves BROKER_SYNC incident when mismatch is cleared after remediation", async () => {
    await upsertIncident({
      severity: "MEDIUM",
      source: "ops",
      category: "BROKER_SYNC",
      title: "Open trade mismatch",
      summary: "Broker positions=0, DB operational open=8.",
      notes: [],
    });

    mocks.readAgentTelemetrySnapshot
      .mockResolvedValueOnce(makeTelemetry({ openTradeMismatch: true, brokerPositionsCount: 0, dbOperationalOpenCount: 8 }))
      .mockResolvedValueOnce(makeTelemetry({ openTradeMismatch: false, brokerPositionsCount: 0, dbOperationalOpenCount: 0 }));

    mocks.executeRemediationForIncident.mockResolvedValue({
      attempted: true,
      success: true,
      summary: "Reconciled stale trades.",
      detail: { checked: 8, closed: 8 },
      error: null,
    });

    await runOpsAgent();

    const openIncidents = await listOpenIncidents(50);
    const brokerSyncOpen = openIncidents.find((inc) => inc.category === "BROKER_SYNC");
    expect(brokerSyncOpen).toBeUndefined();

    const actions = await listAgentActions(100);
    expect(actions.some((a) => a.actionType === "INCIDENT_RESOLVED")).toBe(true);
    const remediationAction = actions.find((a) => a.actionType === "REMEDIATION_SUCCEEDED");
    expect(remediationAction?.summary).toContain("Before: broker=0 db=8.");
    expect(remediationAction?.summary).toContain("After: broker=0 db=0.");
  });

  it("keeps BROKER_SYNC incident in MONITORING when mismatch persists after remediation", async () => {
    const seeded = await upsertIncident({
      severity: "MEDIUM",
      source: "ops",
      category: "BROKER_SYNC",
      title: "Open trade mismatch",
      summary: "Broker positions=0, DB operational open=6.",
      notes: [],
    });

    mocks.readAgentTelemetrySnapshot
      .mockResolvedValueOnce(makeTelemetry({ openTradeMismatch: true, brokerPositionsCount: 0, dbOperationalOpenCount: 6 }))
      .mockResolvedValueOnce(makeTelemetry({ openTradeMismatch: true, brokerPositionsCount: 0, dbOperationalOpenCount: 3 }));

    mocks.executeRemediationForIncident.mockResolvedValue({
      attempted: true,
      success: true,
      summary: "Reconcile run completed.",
      detail: { checked: 6, closed: 3 },
      error: null,
    });

    await runOpsAgent();

    const openIncidents = await listOpenIncidents(50);
    const brokerSync = openIncidents.find((inc) => inc.id === seeded.incident.id);
    expect(brokerSync).toBeTruthy();
    expect(brokerSync?.status).toBe("MONITORING");
    expect(brokerSync?.summary).toContain("mismatch persists");

    const actions = await listAgentActions(100);
    expect(actions.some((a) => a.actionType === "INCIDENT_MONITORING")).toBe(true);
  });
});

describe("Phase 2C - engineering task generation", () => {
  it("creates specific BROKER_SYNC task with success criteria and telemetry snapshot", async () => {
    await upsertIncident({
      severity: "MEDIUM",
      source: "ops",
      category: "BROKER_SYNC",
      title: "Open trade mismatch",
      summary: "Broker positions=0, DB operational open=8.",
      notes: [],
    });

    await runEngineeringAgent();

    const tasks = await listEngineeringTasks(50);
    const task = tasks[0];
    expect(task.title).toBe("Resolve broker/DB open-trade mismatch for stale OPEN trades");
    expect(task.successCriteria).toBeTruthy();
    expect(task.linkedTelemetrySnapshot).toMatchObject({
      brokerPositionsCount: 0,
      dbOperationalOpenCount: 8,
    });
  });

  it("updates existing BROKER_SYNC task with remediation summary when incident moves to MONITORING", async () => {
    const seeded = await upsertIncident({
      severity: "MEDIUM",
      source: "ops",
      category: "BROKER_SYNC",
      title: "Open trade mismatch",
      summary: "Broker positions=0, DB operational open=5.",
      notes: [],
    });

    await runEngineeringAgent();

    await updateIncidentById(seeded.incident.id, {
      status: "MONITORING",
      summary: "Broker positions=0, DB operational open=2. Reconcile ran; mismatch persists.",
    });

    await runEngineeringAgent();

    const tasks = await listEngineeringTasks(50);
    const task = tasks.find((t) => t.incidentId === seeded.incident.id);
    expect(task).toBeTruthy();
    expect(task?.remediationAttempted).toBe(true);
    expect(task?.remediationStatus).toBe("attempted");
    expect(task?.remediationResultSummary).toContain("mismatch persists");
    expect(task?.linkedTelemetrySnapshot).toMatchObject({
      brokerPositionsCount: 0,
      dbOperationalOpenCount: 2,
    });
  });
});
