import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readAgentState: vi.fn(),
  listAgentIncidents: vi.fn(),
  listOpenIncidents: vi.fn(),
  appendAgentBrief: vi.fn(async () => undefined),
  appendAgentAction: vi.fn(async () => ({ id: "action-1" })),
  writeAgentState: vi.fn(async (state: any) => state),
  createDefaultAgentState: vi.fn(() => ({
    allowedGrades: ["A", "B", "C"],
  })),
}));

vi.mock("@/lib/agents/time", () => ({
  nowIso: vi.fn(() => "2026-04-04T15:00:00.000Z"),
}));

vi.mock("@/lib/agents/store", () => ({
  readAgentState: mocks.readAgentState,
  listAgentIncidents: mocks.listAgentIncidents,
  listOpenIncidents: mocks.listOpenIncidents,
  appendAgentBrief: mocks.appendAgentBrief,
  appendAgentAction: mocks.appendAgentAction,
  writeAgentState: mocks.writeAgentState,
  createDefaultAgentState: mocks.createDefaultAgentState,
}));

import { runPmAgent } from "../pm";
import { runRiskAgent } from "../risk";

describe("pm/risk runner behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pm moves to defensive on high incident", async () => {
    mocks.readAgentState.mockResolvedValue({
      posture: "NORMAL",
      eventRisk: "LOW",
      activeRestrictions: [],
      telemetry: { readinessReady: true, readinessReasons: [] },
    });
    mocks.listAgentIncidents.mockResolvedValue([
      { status: "OPEN", severity: "HIGH", category: "SCORING" },
    ]);

    const result = await runPmAgent();

    expect(result.state.posture).toBe("DEFENSIVE");
    expect(result.state.activeRestrictions.some((value: string) => value.includes("high-severity incident"))).toBe(true);
  });

  it("risk tightens to A-only on high critical incident", async () => {
    mocks.readAgentState.mockResolvedValue({
      posture: "NORMAL",
      eventRisk: "LOW",
      activeRestrictions: [],
    });
    mocks.listOpenIncidents.mockResolvedValue([
      { severity: "HIGH", category: "AUTO_ENTRY", status: "OPEN" },
    ]);

    const result = await runRiskAgent();

    expect(result.state.allowedGrades).toEqual(["A"]);
    expect(result.state.minScoreAdjustment).toBe(0.5);
  });
});