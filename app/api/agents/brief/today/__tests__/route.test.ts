import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEtDateString } from "@/lib/agents/time";

vi.mock("@/lib/agents/auth", () => ({
  checkAgentReadAuth: vi.fn(async () => ({ ok: true, authMode: "cron_token" })),
  unauthorizedAgentResponse: vi.fn((error: string) =>
    new Response(JSON.stringify({ ok: false, error }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })
  ),
}));

vi.mock("@/lib/agents/store", () => ({
  listAgentBriefs: vi.fn(),
}));

import { listAgentBriefs } from "@/lib/agents/store";
import { GET } from "../route";

describe("GET /api/agents/brief/today", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes briefs by explicit etDate and falls back to legacy-short-offset parsing", async () => {
    const todayEt = getEtDateString();
    const todayIso = `${todayEt}T14:00:00.000Z`;
    const todayLegacy = `${todayEt}T15:00:00-4`;
    const yesterdayIso = "2020-01-01T12:00:00.000Z";

    vi.mocked(listAgentBriefs).mockResolvedValue([
      {
        id: "b1",
        agent: "ops",
        briefType: "STATUS",
        createdAt: todayIso,
        etDate: todayEt,
        title: "today valid",
        summary: "ok",
      },
      {
        id: "b2",
        agent: "ops",
        briefType: "STATUS",
        createdAt: todayLegacy,
        title: "today legacy",
        summary: "ok",
      },
      {
        id: "b3",
        agent: "ops",
        briefType: "STATUS",
        createdAt: yesterdayIso,
        etDate: "2020-01-01",
        title: "old",
        summary: "old",
      },
      {
        id: "b4",
        agent: "ops",
        briefType: "STATUS",
        createdAt: "bad-ts",
        title: "bad",
        summary: "bad",
      },
    ] as any);

    const response = await GET(new Request("http://localhost/api/agents/brief/today?limit=25"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.date).toBe(todayEt);
    expect(body.briefs.map((b: any) => b.id)).toEqual(["b1", "b2"]);
  });
});