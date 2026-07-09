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

vi.mock("@/lib/redis", () => ({
  redis: mocks.redis,
}));

vi.mock("@/lib/redis/ttl", () => ({
  getTtlSeconds: vi.fn(() => 3600),
  setWithTtl: vi.fn(async (_redis: any, key: string, value: string) => {
    mocks.mem.set(key, value);
    return true;
  }),
}));

vi.mock("@/lib/tradingConfig", () => ({
  getTradingConfig: vi.fn(() => ({
    flags: { allowTierCAutoEntry: true },
  })),
}));

import { listOpenIncidents, resolveIncident, upsertIncident } from "@/lib/agents/store";

describe("agent incident upsert/resolve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mem.clear();
  });

  it("upserts matching open incident instead of duplicating", async () => {
    const created = await upsertIncident({
      severity: "MEDIUM",
      source: "ops",
      category: "SCORING",
      title: "Scoring stale while pending backlog exists",
      summary: "first",
    });

    const updated = await upsertIncident({
      severity: "HIGH",
      source: "ops",
      category: "SCORING",
      title: "Scoring stale while pending backlog exists",
      summary: "second",
      notes: ["note"],
    });

    const open = await listOpenIncidents(20);

    expect(created.created).toBe(true);
    expect(updated.created).toBe(false);
    expect(open).toHaveLength(1);
    expect(open[0].severity).toBe("HIGH");
    expect(open[0].summary).toBe("second");
  });

  it("resolves a matching open incident", async () => {
    await upsertIncident({
      severity: "MEDIUM",
      source: "ops",
      category: "SCANNER",
      title: "Scanner stale during market window",
      summary: "stale",
    });

    const resolved = await resolveIncident(
      { category: "SCANNER", title: "Scanner stale during market window" },
      "recovered"
    );

    const open = await listOpenIncidents(20);

    expect(resolved?.status).toBe("RESOLVED");
    expect(open).toHaveLength(0);
  });
});