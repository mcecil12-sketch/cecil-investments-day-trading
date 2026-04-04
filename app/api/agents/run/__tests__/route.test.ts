import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const readAgentState = vi.fn(async () => ({
    asOf: "2026-04-04T09:30:00-04:00",
    posture: "NORMAL",
    eventRisk: "LOW",
    newsState: "CALM",
    allowedGrades: ["A", "B", "C"],
    minScoreAdjustment: 0,
    maxEntriesOverride: null,
    freezeWindows: [],
    activeRestrictions: [],
    activeIncidentCount: 0,
    latestBriefId: null,
    latestEngineeringTaskId: null,
    updatedBy: "system",
  }));

  return {
    ensureAgentState: vi.fn(async () => undefined),
    readAgentState,
    runPolicyNewsAgent: vi.fn(async () => ({
      agent: "policynews",
      state: await readAgentState(),
      summary: "policy ok",
      briefId: "brief-policy",
    })),
    runOpsAgent: vi.fn(async () => ({
      agent: "ops",
      state: await readAgentState(),
      summary: "ops ok",
      briefId: "brief-ops",
    })),
  };
});

vi.mock("@/lib/agents/store", () => ({
  ensureAgentState: mocks.ensureAgentState,
  readAgentState: mocks.readAgentState,
}));

vi.mock("@/lib/agents/runners", () => ({
  ALL_AGENT_RUN_ORDER: ["policynews", "ops"],
  AGENT_RUNNERS: {
    policynews: mocks.runPolicyNewsAgent,
    ops: mocks.runOpsAgent,
  },
}));

import { POST } from "../route";

describe("POST /api/agents/run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_TOKEN = "test-cron-token";
    delete process.env.CRON_SECRET;
  });

  it("returns 401 without a valid x-cron-token", async () => {
    const response = await POST(
      new Request("http://localhost/api/agents/run?agent=all", {
        method: "POST",
      })
    );

    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      ok: false,
      error: "unauthorized",
      message: "Missing or invalid x-cron-token",
    });
    expect(mocks.ensureAgentState).not.toHaveBeenCalled();
  });

  it("accepts a valid x-cron-token and runs all agents in order", async () => {
    const response = await POST(
      new Request("http://localhost/api/agents/run?agent=all", {
        method: "POST",
        headers: { "x-cron-token": "test-cron-token" },
      })
    );

    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.authMode).toBe("cron_token");
    expect(body.ran).toEqual(["policynews", "ops"]);
    expect(mocks.ensureAgentState).toHaveBeenCalledTimes(1);
    expect(mocks.runPolicyNewsAgent).toHaveBeenCalledTimes(1);
    expect(mocks.runOpsAgent).toHaveBeenCalledTimes(1);
    expect(body.results).toEqual([
      {
        agent: "policynews",
        summary: "policy ok",
        briefId: "brief-policy",
        actionId: null,
        incidentId: null,
        engineeringTaskId: null,
      },
      {
        agent: "ops",
        summary: "ops ok",
        briefId: "brief-ops",
        actionId: null,
        incidentId: null,
        engineeringTaskId: null,
      },
    ]);
  });

  it("returns 400 for an invalid agent selector", async () => {
    const response = await POST(
      new Request("http://localhost/api/agents/run?agent=not-real", {
        method: "POST",
        headers: { "x-cron-token": "test-cron-token" },
      })
    );

    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("invalid_agent");
  });
});