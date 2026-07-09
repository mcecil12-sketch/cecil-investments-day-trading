import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkAgentReadAuth: vi.fn(async () => ({ ok: true as const })),
  listEngineeringTasks: vi.fn(),
}));

vi.mock("@/lib/agents/auth", () => ({
  checkAgentReadAuth: mocks.checkAgentReadAuth,
  unauthorizedAgentResponse: vi.fn((error: string) =>
    Response.json({ ok: false, error }, { status: 401 }),
  ),
}));

vi.mock("@/lib/agents/store", () => ({
  listEngineeringTasks: mocks.listEngineeringTasks,
}));

import { GET } from "../route";

describe("GET /api/agents/engineering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns visibility fields and prioritizes incident + execution readiness", async () => {
    mocks.listEngineeringTasks.mockResolvedValueOnce([
      {
        id: "blocked-1",
        createdAt: "2026-04-05T10:00:00Z",
        updatedAt: "2026-04-05T10:00:00Z",
        status: "BLOCKED",
        title: "Blocked work",
        summary: "",
        likelyFiles: [],
        copilotPrompt: "",
        smokeTestBlock: "",
        gitBlock: "",
      },
      {
        id: "open-incident",
        createdAt: "2026-04-05T11:00:00Z",
        updatedAt: "2026-04-05T11:00:00Z",
        status: "OPEN",
        title: "Incident-linked open",
        summary: "",
        likelyFiles: [],
        copilotPrompt: "",
        smokeTestBlock: "",
        gitBlock: "",
        incidentId: "inc-123",
      },
      {
        id: "ready-1",
        createdAt: "2026-04-05T12:00:00Z",
        updatedAt: "2026-04-05T12:00:00Z",
        status: "READY_FOR_EXECUTION",
        title: "Ready task",
        summary: "",
        likelyFiles: [],
        copilotPrompt: "",
        smokeTestBlock: "",
        gitBlock: "",
        executionStatus: "READY",
      },
    ]);

    const response = await GET(new Request("http://localhost/api/agents/engineering?limit=25"));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.openExecutionReadyCount).toBe(1);
    expect(body.openEngineeringTaskCount).toBe(3);
    expect(body.blockedTaskCount).toBe(1);
    expect(body.latestExecutionTaskTitle).toBe("Ready task");
    expect(body.latestExecutionStatus).toBe("READY");
    expect(body.tasks[0].id).toBe("ready-1");
    expect(body.tasks.at(-1).id).toBe("blocked-1");
  });

  it("does not classify BLOCKED tasks as execution-ready even if executionStatus is READY", async () => {
    mocks.listEngineeringTasks.mockResolvedValueOnce([
      {
        id: "blocked-ready",
        createdAt: "2026-04-05T10:00:00Z",
        updatedAt: "2026-04-05T10:00:00Z",
        status: "BLOCKED",
        title: "Blocked but stale-ready",
        summary: "",
        likelyFiles: [],
        copilotPrompt: "",
        smokeTestBlock: "",
        gitBlock: "",
        executionStatus: "READY",
      },
      {
        id: "ready-true",
        createdAt: "2026-04-05T11:00:00Z",
        updatedAt: "2026-04-05T11:00:00Z",
        status: "READY_FOR_EXECUTION",
        title: "True ready task",
        summary: "",
        likelyFiles: [],
        copilotPrompt: "",
        smokeTestBlock: "",
        gitBlock: "",
        executionStatus: "READY",
      },
    ]);

    const response = await GET(new Request("http://localhost/api/agents/engineering?limit=25"));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.executionReadyTasks).toHaveLength(1);
    expect(body.executionReadyTasks[0].id).toBe("ready-true");
    expect(body.blockedTasks).toHaveLength(1);
    expect(body.blockedTasks[0].id).toBe("blocked-ready");
  });
});
