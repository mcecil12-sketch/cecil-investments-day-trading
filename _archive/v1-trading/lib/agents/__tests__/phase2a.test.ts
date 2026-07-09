/**
 * Phase 2A regression tests:
 *   - Incident fingerprinting + dedupe
 *   - Ops remediation playbook selection
 *   - Engineering task generation for open-trade mismatch
 *   - Engineering task dedupe (upsertEngineeringTask)
 *   - Status transitions OPEN -> MONITORING -> RESOLVED
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory Redis mock
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mem = new Map<string, string>();
  const redis = {
    get: vi.fn(async (key: string) => mem.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      mem.set(key, value);
      return "OK";
    }),
  };
  return { mem, redis };
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

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  listOpenIncidents,
  resolveIncident,
  updateIncidentById,
  upsertEngineeringTask,
  upsertIncident,
} from "@/lib/agents/store";

import {
  classifyIncident,
  compareIncidentSeverity,
  getRemediationType,
  normalizeIncidentFingerprint,
} from "@/lib/agents/incidents";

import { isRemediationOnCooldown } from "@/lib/agents/remediation";

import type { AgentAction, AgentIncident } from "@/lib/agents/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIncident(overrides: Partial<AgentIncident> = {}): AgentIncident {
  const now = new Date().toISOString();
  return {
    id: "test-id",
    createdAt: now,
    updatedAt: now,
    severity: "MEDIUM",
    source: "ops",
    category: "BROKER_SYNC",
    status: "OPEN",
    title: "Open trade mismatch",
    summary: "Broker positions=0, DB operational open=8.",
    notes: [],
    ...overrides,
  };
}

function makeAction(overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    id: "action-id",
    createdAt: new Date().toISOString(),
    agent: "ops",
    actionType: "REMEDIATION_ATTEMPTED",
    status: "APPLIED",
    summary: "test",
    metadata: { incidentId: "test-id" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Incident fingerprinting
// ---------------------------------------------------------------------------

describe("normalizeIncidentFingerprint", () => {
  it("produces stable fingerprint for matching category + title", () => {
    const fp1 = normalizeIncidentFingerprint("BROKER_SYNC", "Open trade mismatch");
    const fp2 = normalizeIncidentFingerprint("BROKER_SYNC", "  open trade mismatch  ");
    expect(fp1).toBe(fp2);
  });

  it("differentiates different categories", () => {
    const fp1 = normalizeIncidentFingerprint("BROKER_SYNC", "Open trade mismatch");
    const fp2 = normalizeIncidentFingerprint("SCORING", "Open trade mismatch");
    expect(fp1).not.toBe(fp2);
  });

  it("collapses repeated whitespace in title", () => {
    const fp = normalizeIncidentFingerprint("SCANNER", "Scanner  stale   during  market");
    expect(fp).toBe("SCANNER::SCANNER STALE DURING MARKET");
  });
});

// ---------------------------------------------------------------------------
// 2. Incident classification
// ---------------------------------------------------------------------------

describe("classifyIncident", () => {
  it("returns BROKER_SYNC remediation type for BROKER_SYNC category", () => {
    const inc = makeIncident({ category: "BROKER_SYNC" });
    const result = classifyIncident(inc);
    expect(result.remediationType).toBe("BROKER_SYNC");
    expect(result.likelyFiles).toContain("lib/broker/truth.ts");
    expect(result.likelyRoutes).toContain("/api/maintenance/reconcile-open-trades");
    expect(result.likelyRootCause).toMatch(/stale/i);
    expect(result.recommendedNextAction).toMatch(/reconcile/i);
  });

  it("returns OBSERVE_ONLY for AUTO_ENTRY", () => {
    const inc = makeIncident({ category: "AUTO_ENTRY" });
    expect(classifyIncident(inc).remediationType).toBe("OBSERVE_ONLY");
  });

  it("returns CONSERVATIVE_LOG for SCORING", () => {
    const inc = makeIncident({ category: "SCORING" });
    expect(classifyIncident(inc).remediationType).toBe("CONSERVATIVE_LOG");
  });

  it("returns CONSERVATIVE_LOG for SCANNER", () => {
    const inc = makeIncident({ category: "SCANNER" });
    expect(classifyIncident(inc).remediationType).toBe("CONSERVATIVE_LOG");
  });

  it("returns NONE for UNKNOWN", () => {
    const inc = makeIncident({ category: "UNKNOWN" });
    expect(getRemediationType(inc)).toBe("NONE");
  });
});

// ---------------------------------------------------------------------------
// 3. Severity comparison
// ---------------------------------------------------------------------------

describe("compareIncidentSeverity", () => {
  it("sorts HIGH before MEDIUM before LOW", () => {
    const incidents = [
      makeIncident({ severity: "LOW" }),
      makeIncident({ severity: "HIGH" }),
      makeIncident({ severity: "MEDIUM" }),
    ];
    const sorted = [...incidents].sort(compareIncidentSeverity);
    expect(sorted[0].severity).toBe("HIGH");
    expect(sorted[1].severity).toBe("MEDIUM");
    expect(sorted[2].severity).toBe("LOW");
  });
});

// ---------------------------------------------------------------------------
// 4. Remediation cooldown guard
// ---------------------------------------------------------------------------

describe("isRemediationOnCooldown", () => {
  it("returns false when no actions exist", () => {
    expect(isRemediationOnCooldown("inc-1", [])).toBe(false);
  });

  it("returns true when REMEDIATION_ATTEMPTED for same incident is recent", () => {
    const recent = makeAction({
      actionType: "REMEDIATION_ATTEMPTED",
      createdAt: new Date().toISOString(),
      metadata: { incidentId: "inc-1" },
    });
    expect(isRemediationOnCooldown("inc-1", [recent])).toBe(true);
  });

  it("returns false when action is for a different incident", () => {
    const recent = makeAction({
      actionType: "REMEDIATION_ATTEMPTED",
      createdAt: new Date().toISOString(),
      metadata: { incidentId: "other-id" },
    });
    expect(isRemediationOnCooldown("inc-1", [recent])).toBe(false);
  });

  it("returns false when REMEDIATION_ATTEMPTED action is stale (>30 min ago)", () => {
    const staleTs = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const stale = makeAction({
      actionType: "REMEDIATION_ATTEMPTED",
      createdAt: staleTs,
      metadata: { incidentId: "inc-1" },
    });
    expect(isRemediationOnCooldown("inc-1", [stale])).toBe(false);
  });

  it("returns false for non-REMEDIATION_ATTEMPTED action types", () => {
    const recent = makeAction({
      actionType: "HEALTH_SUMMARY",
      createdAt: new Date().toISOString(),
      metadata: { incidentId: "inc-1" },
    });
    expect(isRemediationOnCooldown("inc-1", [recent])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Engineering task dedupe via upsertEngineeringTask
// ---------------------------------------------------------------------------

describe("upsertEngineeringTask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mem.clear();
  });

  it("creates a new task when none exists for the incident", async () => {
    const now = new Date().toISOString();
    const task = {
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: "OPEN" as const,
      title: "Investigate open-trade mismatch between broker and DB",
      summary: "MEDIUM BROKER_SYNC incident",
      likelyFiles: ["lib/broker/truth.ts"],
      copilotPrompt: "Investigate...",
      smokeTestBlock: "npm run build",
      gitBlock: "git add -A",
      incidentId: "inc-broker-1",
      incidentCategory: "BROKER_SYNC" as const,
    };
    const result = await upsertEngineeringTask(task);
    expect(result.created).toBe(true);
    expect(result.task.id).toBe(task.id);
  });

  it("returns existing task without creating a duplicate", async () => {
    const now = new Date().toISOString();
    const incidentId = "inc-broker-2";
    const task = {
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: "OPEN" as const,
      title: "Investigate open-trade mismatch between broker and DB",
      summary: "BROKER_SYNC",
      likelyFiles: [],
      copilotPrompt: "...",
      smokeTestBlock: "...",
      gitBlock: "...",
      incidentId,
      incidentCategory: "BROKER_SYNC" as const,
    };

    const first = await upsertEngineeringTask(task);
    const second = await upsertEngineeringTask({ ...task, id: crypto.randomUUID() });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
  });

  it("creates a new task for same incidentId if previous task is DONE", async () => {
    const now = new Date().toISOString();
    const incidentId = "inc-broker-3";

    // Seed a DONE task
    const doneTask = {
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: "DONE" as const,
      title: "Old task",
      summary: "BROKER_SYNC",
      likelyFiles: [],
      copilotPrompt: "...",
      smokeTestBlock: "...",
      gitBlock: "...",
      incidentId,
    };
    await upsertEngineeringTask(doneTask);

    const newTask = {
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: "OPEN" as const,
      title: "New task",
      summary: "BROKER_SYNC",
      likelyFiles: [],
      copilotPrompt: "...",
      smokeTestBlock: "...",
      gitBlock: "...",
      incidentId,
    };
    const result = await upsertEngineeringTask(newTask);
    expect(result.created).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Incident status transition: OPEN -> MONITORING -> RESOLVED
// ---------------------------------------------------------------------------

describe("incident status transitions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mem.clear();
  });

  it("OPEN -> MONITORING via updateIncidentById", async () => {
    const { incident } = await upsertIncident({
      severity: "MEDIUM",
      source: "ops",
      category: "BROKER_SYNC",
      title: "Open trade mismatch",
      summary: "Broker=0 DB=8",
    });

    const updated = await updateIncidentById(incident.id, { status: "MONITORING" }, "remediation applied");
    expect(updated?.status).toBe("MONITORING");

    const open = await listOpenIncidents(10);
    // MONITORING is still "open" (not RESOLVED)
    expect(open.some((i) => i.id === incident.id && i.status === "MONITORING")).toBe(true);
  });

  it("MONITORING -> RESOLVED via resolveIncident", async () => {
    const { incident } = await upsertIncident({
      severity: "MEDIUM",
      source: "ops",
      category: "BROKER_SYNC",
      title: "Open trade mismatch",
      summary: "Broker=0 DB=8",
    });

    await updateIncidentById(incident.id, { status: "MONITORING" }, "remediation applied");

    const resolved = await resolveIncident(
      { category: "BROKER_SYNC", title: "Open trade mismatch" },
      "Counts aligned after reconcile.",
    );
    expect(resolved?.status).toBe("RESOLVED");

    const open = await listOpenIncidents(10);
    expect(open.find((i) => i.id === incident.id)).toBeUndefined();
  });

  it("upsertIncident preserves MONITORING status (no reset to OPEN)", async () => {
    const { incident } = await upsertIncident({
      severity: "MEDIUM",
      source: "ops",
      category: "BROKER_SYNC",
      title: "Open trade mismatch",
      summary: "Broker=0 DB=8",
    });

    // Transition to MONITORING
    await updateIncidentById(incident.id, { status: "MONITORING" });

    // Ops runner re-upserts the incident (same category+title) without a status override
    const { incident: reUpserted, created } = await upsertIncident({
      severity: "MEDIUM",
      source: "ops",
      category: "BROKER_SYNC",
      title: "Open trade mismatch",
      summary: "Broker=0 DB=8 (re-checked)",
    });

    expect(created).toBe(false);
    expect(reUpserted.status).toBe("MONITORING");
  });
});

// ---------------------------------------------------------------------------
// 7. Engineering task for open-trade mismatch: task specifics
// ---------------------------------------------------------------------------

describe("engineering task for BROKER_SYNC incident", () => {
  it("classifyIncident returns expected entries for BROKER_SYNC", () => {
    const inc = makeIncident({
      category: "BROKER_SYNC",
      title: "Open trade mismatch",
      summary: "Broker positions=0, DB operational open=8.",
    });
    const classification = classifyIncident(inc);
    expect(classification.likelyFiles).toContain("lib/broker/truth.ts");
    expect(classification.likelyFiles).toContain("lib/trades/operational.ts");
    expect(classification.likelyFiles).toContain("lib/maintenance/reconcileOpenTrades.ts");
    expect(classification.likelyRoutes).toContain("/api/maintenance/reconcile-open-trades");
    expect(classification.likelyRoutes).toContain("/api/ops/status");
    expect(classification.likelyRootCause).toMatch(/DB has open trades/);
    expect(classification.remediationType).toBe("BROKER_SYNC");
  });
});
