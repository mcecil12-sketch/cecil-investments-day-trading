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

import { runEngineeringManagerAgent } from "@/lib/agents/runners/engineering-manager";
import { appendEngineeringTask, listEngineeringTasks, readAgentState } from "@/lib/agents/store";

beforeEach(() => {
  mocks.mem.clear();
  vi.clearAllMocks();
});

describe("engineering manager execution readiness", () => {
  it("marks governance-approved tasks ready for execution and updates state visibility", async () => {
    const now = new Date().toISOString();

    await appendEngineeringTask({
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: "OPEN",
      title: "Enable GitHub API write access",
      summary: "Allow agents to prepare GitHub write payloads.",
      likelyFiles: ["app/api/agents/execute/route.ts"],
      copilotPrompt: "Refactor execution route into orchestrator only",
      smokeTestBlock: "GET /api/agents/engineering",
      gitBlock: "git add -A && git commit -m \"phase 2d.1\" && git push",
      remediationAttempted: false,
      remediationStatus: "none",
    });

    await runEngineeringManagerAgent();

    const tasks = await listEngineeringTasks(20);
    expect(tasks[0].status).toBe("READY_FOR_EXECUTION");
    expect(tasks[0].executionStatus).toBe("READY");
    expect(tasks[0].commitPlan?.targetBranch).toBe("main");

    const state = await readAgentState();
    expect(state.openExecutionReadyCount).toBe(1);
    expect(state.blockedTaskCount).toBe(0);
    expect(state.latestExecutionTaskTitle).toBe("Enable GitHub API write access");
    expect(state.latestExecutionStatus).toBe("READY_FOR_EXECUTION");
  });

  it("marks blocked tasks when governance fails", async () => {
    const now = new Date().toISOString();

    await appendEngineeringTask({
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      status: "OPEN",
      title: "Dangerous task",
      summary: "Should be blocked.",
      likelyFiles: ["lib/agents/governance/manager.ts"],
      copilotPrompt: "rm -rf /tmp/foo",
      smokeTestBlock: "",
      gitBlock: "",
      remediationAttempted: false,
      remediationStatus: "none",
    });

    await runEngineeringManagerAgent();

    const tasks = await listEngineeringTasks(20);
    expect(tasks[0].status).toBe("BLOCKED");
    expect(tasks[0].executionStatus).toBe("BLOCKED");
    expect(tasks[0].executionError).toBe("blocked_pattern_detected");

    const state = await readAgentState();
    expect(state.blockedTaskCount).toBe(1);
  });
});