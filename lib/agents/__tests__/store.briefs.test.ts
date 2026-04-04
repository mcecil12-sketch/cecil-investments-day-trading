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

import { appendAgentBrief } from "@/lib/agents/store";

describe("agent brief normalization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mem.clear();
  });

  it("stores newly appended briefs with strict ISO createdAt and etDate", async () => {
    const brief = await appendAgentBrief({
      id: "brief-1",
      agent: "ops",
      briefType: "STATUS",
      createdAt: "2026-04-03T23:42:10-4",
      title: "ops brief",
      summary: "summary",
    });

    expect(brief.createdAt).toBe("2026-04-04T03:42:10.000Z");
    expect(brief.etDate).toBe("2026-04-03");
  });
});