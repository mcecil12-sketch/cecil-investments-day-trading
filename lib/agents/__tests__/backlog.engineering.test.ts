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

import { runEngineeringAgent } from "@/lib/agents/runners/engineering";
import {
  appendEngineeringTask,
  listBacklogItems,
  listEngineeringTasks,
  readAgentState,
  updateBacklogStatus,
  upsertBacklogItem,
  upsertIncident,
} from "@/lib/agents/store";

beforeEach(() => {
  mocks.mem.clear();
  vi.clearAllMocks();
});

describe("backlog + engineering runner", () => {
  it("resolved incident closes linked OPEN engineering task", async () => {
    const incident = await upsertIncident({
      severity: "MEDIUM",
      source: "ops",
      category: "BROKER_SYNC",
      title: "Open trade mismatch",
      summary: "Resolved mismatch.",
      status: "RESOLVED",
      notes: [],
    });

    const now = new Date().toISOString();
    await appendEngineeringTask({
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: "OPEN",
      title: "Resolve mismatch",
      summary: "Linked to resolved incident",
      likelyFiles: [],
      copilotPrompt: "prompt",
      smokeTestBlock: "npm run test",
      gitBlock: "git add -A",
      incidentId: incident.incident.id,
      incidentCategory: "BROKER_SYNC",
      remediationStatus: "none",
    });

    await runEngineeringAgent();

    const tasks = await listEngineeringTasks(50);
    expect(tasks[0].status).toBe("DONE");
    expect(tasks[0].notes?.some((n) => n.includes("Auto-closed: incident resolved"))).toBe(true);
  });

  it("backlog store supports create fetch and update status", async () => {
    const created = await upsertBacklogItem({
      status: "OPEN",
      type: "FEATURE",
      priority: "HIGH",
      title: "Test backlog item",
      summary: "Backlog summary",
      assignedAgent: "engineering",
    });

    expect(created.created).toBe(true);

    const listed = await listBacklogItems(20);
    expect(listed.find((item) => item.id === created.item.id)).toBeTruthy();

    await updateBacklogStatus(created.item.id, "IN_PROGRESS");
    const updatedList = await listBacklogItems(20);
    expect(updatedList.find((item) => item.id === created.item.id)?.status).toBe("IN_PROGRESS");
  });

  it("engineering pulls backlog when no incidents and marks selected item IN_PROGRESS", async () => {
    const seeded = await upsertBacklogItem({
      status: "OPEN",
      type: "OPTIMIZATION",
      priority: "HIGH",
      title: "Backlog candidate",
      summary: "Should become engineering task",
      assignedAgent: "engineering",
    });

    await runEngineeringAgent();

    const tasks = await listEngineeringTasks(50);
    const linkedTask = tasks.find((task) => task.backlogItemId === seeded.item.id);
    expect(linkedTask).toBeTruthy();
    expect(linkedTask?.patchPlan?.proposedChangesSummary).toContain("Backlog candidate");
    expect(linkedTask?.validationPlan?.testCommands).toContain("npm run test");
    expect(linkedTask?.commitPlan?.targetBranch).toBe("main");
    expect(linkedTask?.executionStatus).toBe("PENDING");
    expect(linkedTask?.likelyFiles.length).toBeGreaterThan(0);

    const backlog = await listBacklogItems(50);
    expect(backlog.find((item) => item.id === seeded.item.id)?.status).toBe("IN_PROGRESS");
  });

  it("does not repeatedly pick the same backlog item while task is still open", async () => {
    const seeded = await upsertBacklogItem({
      status: "OPEN",
      type: "TECH_DEBT",
      priority: "HIGH",
      title: "Single pick item",
      summary: "Must not duplicate",
      assignedAgent: "engineering",
    });

    await runEngineeringAgent();
    await runEngineeringAgent();

    const tasks = await listEngineeringTasks(100);
    const linkedTasks = tasks.filter((task) => task.backlogItemId === seeded.item.id);
    expect(linkedTasks.length).toBe(1);
  });

  it("does not create backlog-driven tasks when unresolved tasks already exist", async () => {
    const now = new Date().toISOString();
    await appendEngineeringTask({
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: "OPEN",
      title: "Existing unresolved",
      summary: "Should block backlog pull",
      likelyFiles: ["lib/agents/runners/engineering.ts"],
      copilotPrompt: "prompt",
      smokeTestBlock: "npm run test",
      gitBlock: "git add -A",
      remediationStatus: "none",
    });

    const seeded = await upsertBacklogItem({
      status: "OPEN",
      type: "OPTIMIZATION",
      priority: "HIGH",
      title: "Backlog must wait",
      summary: "Must not become task while unresolved exists",
      assignedAgent: "engineering",
    });

    await runEngineeringAgent();

    const tasks = await listEngineeringTasks(100);
    const linkedTask = tasks.find((task) => task.backlogItemId === seeded.item.id);
    expect(linkedTask).toBeUndefined();

    const backlog = await listBacklogItems(100);
    expect(backlog.find((item) => item.id === seeded.item.id)?.status).toBe("OPEN");
  });

  it("updates execution visibility counts and latest execution fields", async () => {
    const now = new Date().toISOString();

    await appendEngineeringTask({
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: "BLOCKED",
      title: "Blocked task",
      summary: "blocked",
      likelyFiles: ["lib/agents/governance/manager.ts"],
      copilotPrompt: "blocked",
      smokeTestBlock: "",
      gitBlock: "",
      remediationStatus: "failed",
      executionStatus: "BLOCKED",
      executionError: "blocked_pattern_detected",
    });

    await appendEngineeringTask({
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: "READY_FOR_EXECUTION",
      title: "Ready task",
      summary: "ready",
      likelyFiles: ["app/api/agents/execute/route.ts"],
      copilotPrompt: "safe",
      smokeTestBlock: "GET /api/agents/engineering",
      gitBlock: "git add -A",
      remediationStatus: "attempted",
      executionStatus: "READY",
      executionError: null,
    });

    await runEngineeringAgent();

    const state = await readAgentState();
    expect(state.openExecutionReadyCount).toBe(1);
    expect(state.blockedTaskCount).toBe(1);
    expect(state.latestExecutionTaskTitle).toBe("Ready task");
    expect(state.latestExecutionStatus).toBe("READY_FOR_EXECUTION");
  });

  it("does not create backlog-driven tasks when unresolved task is BLOCKED", async () => {
    const now = new Date().toISOString();
    await appendEngineeringTask({
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: "BLOCKED",
      title: "Blocked unresolved",
      summary: "Should still gate backlog creation",
      likelyFiles: ["lib/agents/runners/engineering.ts"],
      copilotPrompt: "prompt",
      smokeTestBlock: "npm run test",
      gitBlock: "git add -A",
      remediationStatus: "failed",
      executionStatus: "BLOCKED",
      executionError: "blocked_pattern_detected",
    });

    const seeded = await upsertBacklogItem({
      status: "OPEN",
      type: "TECH_DEBT",
      priority: "HIGH",
      title: "Blocked gate candidate",
      summary: "Must remain backlog-only",
      assignedAgent: "engineering",
    });

    await runEngineeringAgent();

    const tasks = await listEngineeringTasks(100);
    expect(tasks.find((task) => task.backlogItemId === seeded.item.id)).toBeUndefined();
  });
});
