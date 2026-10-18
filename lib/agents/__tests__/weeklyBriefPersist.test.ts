import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  events: [] as string[],
  briefExists: false,
  newsMode: "hang" as "hang" | "ok",
  analystMode: "ok" as "ok" | "throw",
  candidatesPresent: true,
}));

const riskOutput = { critical: [{ title: "Concentration", detail: "d", accountId: null }], watch: [], opportunityCost: [] };

const scanOutput = { topCandidates: [{ symbol: "AAA", name: "Aaa Inc", sector: "Technology", rationale: "r", vsSpx: 5, accountType: "taxable" }] };

vi.mock("@/lib/prisma", () => ({
  prisma: {
    agentRun: {
      findFirst: vi.fn(async ({ where }: { where: { agentType: string } }) => {
        if (!h.candidatesPresent) return null;
        if (where.agentType === "RISK_MANAGER") return { id: "risk1", output: riskOutput };
        if (where.agentType === "CANDIDATE_SCANNER") return { id: "scan1", output: scanOutput };
        return null;
      }),
      create: vi.fn(async () => ({ id: "pa-run" })),
      update: vi.fn(async () => ({})),
    },
    account: { findMany: vi.fn(async () => []) },
    weeklyBrief: {
      findUnique: vi.fn(async () => (h.briefExists ? { id: "existing" } : null)),
      create: vi.fn(async () => (h.events.push("brief.create"), { id: "new-brief" })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (h.events.push(`brief.update:${Object.keys(data).sort().join(",")}`), {})),
    },
    actionItem: { deleteMany: vi.fn(async () => ({})) },
    scanHealth: { create: vi.fn(async () => ({})) },
    sentimentFetchState: { count: vi.fn(async () => 0) },
    $transaction: vi.fn(async () => (h.events.push("brief.txn"), [])),
  },
}));
vi.mock("@/lib/agents/cio", () => ({
  synthesizeCioBrief: vi.fn(async (c: Array<{ key: string; agentRunId: string }>) => ({
    summary: "S",
    orderedItems: c.map((x) => ({ ...x, action: "a", rationale: "r", expectedImpact: null, accountId: null })),
    taxableOpportunities: null,
  })),
}));
vi.mock("@/lib/agents/cioPolicyContext", () => ({
  buildCioPolicyContext: vi.fn(async () => ({ group3: null, verizon: null })),
}));
vi.mock("@/lib/agents/newsSentiment", () => ({
  generateNewsSentimentNotes: vi.fn(() => {
    h.events.push("news.start");
    return h.newsMode === "hang" ? new Promise(() => {}) : Promise.resolve([]);
  }),
}));
vi.mock("@/lib/agents/performanceAnalyst", () => ({
  runPerformanceAnalyst: vi.fn(async () => {
    h.events.push("analyst.start");
    if (h.analystMode === "throw") throw new Error("analyst boom");
    return { topWinnerPatterns: [] };
  }),
}));

const { synthesizeWeeklyBrief, BRIEF_NEWS_TIMEOUT_MS } = await import("@/lib/agents/runner");

beforeEach(() => {
  h.events.length = 0;
  h.briefExists = false;
  h.newsMode = "hang";
  h.analystMode = "ok";
  h.candidatesPresent = true;
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());

async function run() {
  const p = synthesizeWeeklyBrief();
  await vi.advanceTimersByTimeAsync(BRIEF_NEWS_TIMEOUT_MS + 1000);
  return p;
}

describe("synthesizeWeeklyBrief: write the brief first, enrich second", () => {
  it("the brief row exists before the slow steps start, and a hung news step only degrades the run", async () => {
    // The scenario that previously lost the whole brief: enrichment never returns.
    const result = await run();
    expect(h.events.indexOf("brief.create")).toBeGreaterThanOrEqual(0);
    expect(h.events.indexOf("brief.create")).toBeLessThan(h.events.indexOf("news.start"));
    expect(h.events.indexOf("brief.create")).toBeLessThan(h.events.indexOf("analyst.start"));
    expect(result.outcome).toBe("created");
    expect(result.warnings.join()).toMatch(/News sentiment notes step failed: News sentiment notes timed out after 90s/);
    // the analyst section is still saved by a follow-up update
    expect(h.events).toContain("brief.update:performanceAnalysis");
  });

  it("a failing analyst step is recorded as a warning, not a lost brief", async () => {
    h.newsMode = "ok";
    h.analystMode = "throw";
    const result = await run();
    expect(result.outcome).toBe("created");
    expect(result.warnings.join()).toMatch(/Performance Analyst run failed: analyst boom/);
  });

  it("an existing week's brief is updated in place (outcome 'updated'), not duplicated", async () => {
    h.newsMode = "ok";
    h.briefExists = true;
    const result = await run();
    expect(result.outcome).toBe("updated");
    expect(h.events).toContain("brief.txn");
    expect(h.events).not.toContain("brief.create");
  });

  it("no completed agent output is an explicit skip with a reason (not a silent void)", async () => {
    h.candidatesPresent = false;
    const result = await run();
    expect(result.outcome).toBe("skipped");
    expect(result.reason).toMatch(/No candidate items/);
    expect(h.events).toEqual([]);
  });
});
