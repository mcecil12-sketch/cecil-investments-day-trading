import { afterEach, describe, expect, it, vi } from "vitest";
import type { PerformanceAnalystContext } from "@/lib/agents/performanceAnalyst";

const candidateFindMany = vi.fn();
const sentimentFindMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    candidateRecommendationLog: { findMany: candidateFindMany },
    sentimentFetchState: { findMany: sentimentFindMany },
  },
}));

const getPriceHistory = vi.fn();
vi.mock("@/lib/agents/marketData", () => ({ getPriceHistory }));

const messagesCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: messagesCreate };
  },
}));

const { buildPerformanceAnalystContext, synthesizePerformanceAnalysis, runPerformanceAnalyst } = await import(
  "@/lib/agents/performanceAnalyst"
);

function batchDate(n: number): Date {
  return new Date(Date.UTC(2026, 0, 1 + n * 7));
}

const originalApiKey = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  vi.clearAllMocks();
  process.env.ANTHROPIC_API_KEY = originalApiKey;
});

/**
 * AAPL: two consecutive weekly appearances, then two consecutive misses ->
 * closes (buildTrackedPositions' asymmetric entry/exit rule, replayed
 * unchanged from recommendationPerformance.ts). MSFT: appears in the last
 * two batches and stays open. Mirrors the fixture shape used in
 * recommendationPerformance.test.ts.
 */
function group1Rows() {
  return [
    { symbol: "AAPL", batchTag: "w0", recommendedAt: batchDate(0), score: 90, sector: "Technology", vsSpx: 5, earningsSurpriseCoverage: "sue" },
    { symbol: "AAPL", batchTag: "w1", recommendedAt: batchDate(1), score: 88, sector: "Technology", vsSpx: 4, earningsSurpriseCoverage: "sue" },
    { symbol: "MSFT", batchTag: "w2", recommendedAt: batchDate(2), score: 70, sector: "Technology", vsSpx: 2, earningsSurpriseCoverage: "insufficient_data" },
    { symbol: "MSFT", batchTag: "w3", recommendedAt: batchDate(3), score: 70, sector: "Technology", vsSpx: 2, earningsSurpriseCoverage: "insufficient_data" },
  ];
}

describe("buildPerformanceAnalystContext", () => {
  it("returns an empty, zeroed context when there are no GROUP_1 rows yet", async () => {
    candidateFindMany.mockResolvedValueOnce([]);
    const context = await buildPerformanceAnalystContext();
    expect(context.totalPositions).toBe(0);
    expect(context.closedPositions).toBe(0);
    expect(context.scoreCorrelation).toEqual({ coefficient: null, sampleSize: 0 });
    expect(context.sentimentDataSufficient).toBe(false);
    expect(sentimentFindMany).not.toHaveBeenCalled();
  });

  it("replays real CandidateRecommendationLog rows into closed/open positions and realized-return aggregates, entirely via recommendationPerformance.ts's own position/PnL logic", async () => {
    candidateFindMany.mockResolvedValueOnce(group1Rows());
    getPriceHistory.mockResolvedValueOnce({
      symbol: "AAPL",
      points: [
        { date: batchDate(0), close: 100 },
        { date: batchDate(2), close: 110 },
      ],
      source: "yahoo",
    });
    sentimentFindMany.mockResolvedValueOnce([]);

    const context = await buildPerformanceAnalystContext();

    expect(context.totalPositions).toBe(2);
    expect(context.closedPositions).toBe(1);
    expect(context.openPositions).toBe(1);
    expect(getPriceHistory).toHaveBeenCalledTimes(1);
    expect(getPriceHistory).toHaveBeenCalledWith("AAPL"); // MSFT never fetched — still open, no realized P&L to compute

    expect(context.winners[0]).toMatchObject({ symbol: "AAPL", sector: "Technology", entryScore: 90, earningsSurpriseCoverage: "sue" });
    expect(context.winners[0].realizedPnlPct).toBeCloseTo(0.005, 6); // 0.05 conviction midpoint * 10% return
    expect(context.losers[0].symbol).toBe("AAPL"); // only one closed position -> appears in both

    // Below MIN_CLOSED_POSITIONS_FOR_CORRELATION -> null coefficient, not a fabricated one from n=1
    expect(context.scoreCorrelation).toEqual({ coefficient: null, sampleSize: 1 });

    expect(context.sectorBreakdown).toHaveLength(1);
    expect(context.sectorBreakdown[0].key).toBe("Technology");
    expect(context.sectorBreakdown[0].count).toBe(1);
    expect(context.sectorBreakdown[0].avgRealizedPnlPct).toBeCloseTo(0.005, 6);
    expect(context.sentimentDataSufficient).toBe(false);
    expect(context.sentimentCoveredSymbolCount).toBe(0);
  });
});

describe("synthesizePerformanceAnalysis / runPerformanceAnalyst", () => {
  it("falls back without calling Claude when there are zero closed positions", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const context: PerformanceAnalystContext = {
      group: "GROUP_1",
      totalPositions: 1,
      closedPositions: 0,
      openPositions: 1,
      trackedSince: null,
      scoreCorrelation: { coefficient: null, sampleSize: 0 },
      winners: [],
      losers: [],
      sectorBreakdown: [],
      earningsSurpriseCoverageBreakdown: [],
      holdingDaysStats: { avgWinnerHoldingDays: null, avgLoserHoldingDays: null },
      sentimentDataSufficient: false,
      sentimentCoveredSymbolCount: 0,
      sentimentOldestFetchDaysAgo: null,
      fragility: null,
      insider: null,
    };
    const output = await synthesizePerformanceAnalysis(context);
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(output.sentimentSignalNote).toBeNull();
  });

  it("falls back without calling Claude when ANTHROPIC_API_KEY is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const context: PerformanceAnalystContext = {
      group: "GROUP_1",
      totalPositions: 1,
      closedPositions: 1,
      openPositions: 0,
      trackedSince: "2026-01-01T00:00:00.000Z",
      scoreCorrelation: { coefficient: null, sampleSize: 1 },
      winners: [],
      losers: [],
      sectorBreakdown: [],
      earningsSurpriseCoverageBreakdown: [],
      holdingDaysStats: { avgWinnerHoldingDays: null, avgLoserHoldingDays: null },
      sentimentDataSufficient: false,
      sentimentCoveredSymbolCount: 0,
      sentimentOldestFetchDaysAgo: null,
      fragility: null,
      insider: null,
    };
    const output = await synthesizePerformanceAnalysis(context);
    expect(messagesCreate).not.toHaveBeenCalled();
    expect(output.sentimentSignalNote).toBeNull();
  });

  it("forces sentimentSignalNote to null when sentimentDataSufficient is false, even if Claude reports a signal anyway (guards against fabricating a correlation from <2 weeks of sentiment history)", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    messagesCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "submit_performance_analysis",
          input: {
            topWinnerPatterns: ["AAPL led on strong momentum"],
            topLoserPatterns: [],
            bestSetupTypes: ["Technology sector setups outperformed"],
            scoreVsRealizedRNote: "Not enough closed positions yet to judge predictive power.",
            earlyExitPatterns: [],
            // Claude ignoring the instruction and fabricating a claim anyway —
            // the code-level guard must still win.
            sentimentSignalNote: "Sentiment strongly predicts returns for this universe.",
          },
        },
      ],
    });

    const context: PerformanceAnalystContext = {
      group: "GROUP_1",
      totalPositions: 1,
      closedPositions: 1,
      openPositions: 0,
      trackedSince: "2026-01-01T00:00:00.000Z",
      scoreCorrelation: { coefficient: null, sampleSize: 1 },
      winners: [],
      losers: [],
      sectorBreakdown: [],
      earningsSurpriseCoverageBreakdown: [],
      holdingDaysStats: { avgWinnerHoldingDays: null, avgLoserHoldingDays: null },
      // Sentiment fetching only started a few days ago — not enough history yet.
      sentimentDataSufficient: false,
      sentimentCoveredSymbolCount: 3,
      sentimentOldestFetchDaysAgo: 3,
      fragility: null,
      insider: null,
    };

    const output = await synthesizePerformanceAnalysis(context);
    expect(output.sentimentSignalNote).toBeNull();
    expect(output.topWinnerPatterns).toEqual(["AAPL led on strong momentum"]);
  });

  it("passes a valid JSON serialization of the real performance context as Claude's user message", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    candidateFindMany.mockResolvedValueOnce(group1Rows());
    getPriceHistory.mockResolvedValueOnce({
      symbol: "AAPL",
      points: [
        { date: batchDate(0), close: 100 },
        { date: batchDate(2), close: 110 },
      ],
      source: "yahoo",
    });
    sentimentFindMany.mockResolvedValueOnce([]);
    messagesCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          name: "submit_performance_analysis",
          input: {
            topWinnerPatterns: [],
            topLoserPatterns: [],
            bestSetupTypes: [],
            scoreVsRealizedRNote: "n/a",
            earlyExitPatterns: [],
            sentimentSignalNote: "",
          },
        },
      ],
    });

    await runPerformanceAnalyst();

    expect(messagesCreate).toHaveBeenCalledTimes(1);
    const callArgs = messagesCreate.mock.calls[0][0];
    const sentContent = callArgs.messages[0].content as string;
    const parsed = JSON.parse(sentContent);

    expect(parsed.group).toBe("GROUP_1");
    expect(parsed.closedPositions).toBe(1);
    expect(parsed.openPositions).toBe(1);
    expect(parsed.sentimentDataSufficient).toBe(false);
    expect(parsed.winners[0].symbol).toBe("AAPL");
    expect(parsed.sectorBreakdown[0]).toMatchObject({ key: "Technology", count: 1 });
  });
});

describe("computeFragilityStats guard", () => {
  const obs = (n: number, flagged: boolean, ret: number, vol = 0.5) =>
    Array.from({ length: n }, () => ({ fragilityFlag: flagged, vol60d: vol, forwardReturn: ret }));

  it("is null below 3 monthly cycles or below 10 closed positions", async () => {
    const { computeFragilityStats } = await import("@/lib/agents/performanceAnalyst");
    expect(computeFragilityStats([...obs(5, true, -0.1), ...obs(5, false, 0.1)], 2)).toBeNull();
    expect(computeFragilityStats([...obs(4, true, -0.1), ...obs(5, false, 0.1)], 3)).toBeNull();
  });

  it("compares flagged vs unflagged once both thresholds are met", async () => {
    const { computeFragilityStats } = await import("@/lib/agents/performanceAnalyst");
    const stats = computeFragilityStats([...obs(5, true, -0.1, 0.5), ...obs(5, false, 0.1, 0.25)], 3)!;
    expect(stats.flagged).toEqual({ count: 5, avgForwardReturn: -0.1, avgReturnPerUnitVol: -0.2 });
    expect(stats.unflagged).toEqual({ count: 5, avgForwardReturn: 0.1, avgReturnPerUnitVol: 0.4 });
  });

  it("forces fragilityNote to null when fragility is null, even if Claude asserts a conclusion", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    messagesCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          input: {
            topWinnerPatterns: [], topLoserPatterns: [], bestSetupTypes: [], scoreVsRealizedRNote: "n/a", earlyExitPatterns: [],
            sentimentSignalNote: "", fragilityNote: "Fragile names clearly underperform.",
          },
        },
      ],
    });
    const context: PerformanceAnalystContext = {
      group: "GROUP_1", totalPositions: 1, closedPositions: 1, openPositions: 0, trackedSince: null,
      scoreCorrelation: { coefficient: null, sampleSize: 1 }, winners: [], losers: [], sectorBreakdown: [],
      earningsSurpriseCoverageBreakdown: [], holdingDaysStats: { avgWinnerHoldingDays: null, avgLoserHoldingDays: null },
      sentimentDataSufficient: false, sentimentCoveredSymbolCount: 0, sentimentOldestFetchDaysAgo: null, fragility: null, insider: null,
    };
    const output = await synthesizePerformanceAnalysis(context);
    expect(output.fragilityNote).toBeNull();
  });
});

describe("computeInsiderStats guard + relative cut", () => {
  const obs = (n: number, top: boolean, ret: number, vol = 0.5) =>
    Array.from({ length: n }, () => ({ fragilityFlag: null, vol60d: vol, forwardReturn: ret, insiderTopThird: top }));

  it("is null below 3 cycles or 10 positions with insider data", async () => {
    const { computeInsiderStats } = await import("@/lib/agents/performanceAnalyst");
    expect(computeInsiderStats([...obs(5, true, -0.1), ...obs(5, false, 0.1)], 2)).toBeNull();
    expect(computeInsiderStats([...obs(4, true, -0.1), ...obs(5, false, 0.1)], 3)).toBeNull();
  });

  it("compares top third vs. rest once the guard is met", async () => {
    const { computeInsiderStats } = await import("@/lib/agents/performanceAnalyst");
    const stats = computeInsiderStats([...obs(5, true, -0.1, 0.5), ...obs(5, false, 0.1, 0.25)], 3)!;
    expect(stats.topThird).toEqual({ count: 5, avgForwardReturn: -0.1, avgReturnPerUnitVol: -0.2 });
    expect(stats.rest).toEqual({ count: 5, avgForwardReturn: 0.1, avgReturnPerUnitVol: 0.4 });
  });

  it("markInsiderTopThird ranks within each cohort: top ceil(n/3), ties by symbol, small cohorts and nulls omitted", async () => {
    const { markInsiderTopThird } = await import("@/lib/agents/performanceAnalyst");
    const d1 = new Date("2026-10-01");
    const d2 = new Date("2026-11-01");
    const mk = (symbol: string, batchTag: string, recommendedAt: Date, usd: number | null) => ({ symbol, batchTag, recommendedAt, insiderNetSoldUsd30d: usd });
    const marks = markInsiderTopThird([
      mk("A", "m1", d1, 100), mk("B", "m1", d1, 900), mk("C", "m1", d1, 500), mk("D", "m1", d1, 500), mk("E", "m1", d1, 1), mk("F", "m1", d1, null),
      mk("X", "m2", d2, 5), mk("Y", "m2", d2, 6),
    ]);
    // m1: 5 with data -> top ceil(5/3)=2: B (900), then C (500, ties by symbol before D)
    expect(marks.get(`B@@${d1.getTime()}`)).toBe(true);
    expect(marks.get(`C@@${d1.getTime()}`)).toBe(true);
    expect(marks.get(`D@@${d1.getTime()}`)).toBe(false);
    expect(marks.get(`A@@${d1.getTime()}`)).toBe(false);
    expect(marks.has(`F@@${d1.getTime()}`)).toBe(false);
    // m2: only 2 with data -> cohort omitted
    expect(marks.has(`X@@${d2.getTime()}`)).toBe(false);
  });

  it("forces insiderNote to null when insider is null, even if Claude asserts a conclusion", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    messagesCreate.mockResolvedValueOnce({
      content: [
        {
          type: "tool_use",
          input: {
            topWinnerPatterns: [], topLoserPatterns: [], bestSetupTypes: [], scoreVsRealizedRNote: "n/a", earlyExitPatterns: [],
            sentimentSignalNote: "", fragilityNote: "", insiderNote: "Insider selling clearly predicts losses.",
          },
        },
      ],
    });
    const context: PerformanceAnalystContext = {
      group: "GROUP_1", totalPositions: 1, closedPositions: 1, openPositions: 0, trackedSince: null,
      scoreCorrelation: { coefficient: null, sampleSize: 1 }, winners: [], losers: [], sectorBreakdown: [],
      earningsSurpriseCoverageBreakdown: [], holdingDaysStats: { avgWinnerHoldingDays: null, avgLoserHoldingDays: null },
      sentimentDataSufficient: false, sentimentCoveredSymbolCount: 0, sentimentOldestFetchDaysAgo: null, fragility: null, insider: null,
    };
    expect((await synthesizePerformanceAnalysis(context)).insiderNote).toBeNull();
  });
});
