import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkAgentReadAuth: vi.fn(async () => ({ ok: true as const })),
  ensureAgentState: vi.fn(async () => ({
    asOf: "2026-04-05T12:00:00Z",
    posture: "NORMAL",
    eventRisk: "LOW",
    newsState: "CALM",
    allowedGrades: ["A", "B", "C"],
    minScoreAdjustment: 0,
    maxEntriesOverride: null,
    freezeWindows: [],
    activeRestrictions: [],
    activeIncidentCount: 0,
    updatedBy: "engineering",
  })),
  readAgentStateSnapshot: vi.fn(async () => ({ source: "stored", state: {} })),
  listEngineeringTasks: vi.fn(),
}));

vi.mock("@/lib/agents/auth", () => ({
  checkAgentReadAuth: mocks.checkAgentReadAuth,
  unauthorizedAgentResponse: vi.fn((error: string) => Response.json({ ok: false, error }, { status: 401 })),
}));

vi.mock("@/lib/agents/store", () => ({
  ensureAgentState: mocks.ensureAgentState,
  readAgentStateSnapshot: mocks.readAgentStateSnapshot,
  listEngineeringTasks: mocks.listEngineeringTasks,
}));

import { GET } from "../route";

describe("GET /api/agents/state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("derives state execution counts directly from engineering queue", async () => {
    mocks.listEngineeringTasks.mockResolvedValueOnce([
      {
        id: "open-1",
        createdAt: "2026-04-05T09:00:00Z",
        updatedAt: "2026-04-05T09:00:00Z",
        status: "OPEN",
        title: "Open task",
        summary: "",
        likelyFiles: [],
        copilotPrompt: "",
        smokeTestBlock: "",
        gitBlock: "",
      },
      {
        id: "ready-1",
        createdAt: "2026-04-05T10:00:00Z",
        updatedAt: "2026-04-05T10:00:00Z",
        status: "READY_FOR_EXECUTION",
        title: "Ready task",
        summary: "",
        likelyFiles: [],
        copilotPrompt: "",
        smokeTestBlock: "",
        gitBlock: "",
        executionStatus: "READY",
      },
      {
        id: "blocked-1",
        createdAt: "2026-04-05T11:00:00Z",
        updatedAt: "2026-04-05T11:00:00Z",
        status: "BLOCKED",
        title: "Blocked task",
        summary: "",
        likelyFiles: [],
        copilotPrompt: "",
        smokeTestBlock: "",
        gitBlock: "",
      },
    ]);

    const response = await GET(new Request("http://localhost/api/agents/state"));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.state.openEngineeringTaskCount).toBe(3);
    expect(body.state.openExecutionReadyCount).toBe(1);
    expect(body.state.blockedTaskCount).toBe(1);
    expect(body.state.latestExecutionTaskTitle).toBe("Ready task");
    expect(body.state.latestExecutionStatus).toBe("READY");
  });
});
