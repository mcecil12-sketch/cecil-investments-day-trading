import { afterEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const findMany = vi.fn();
const upsert = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { agentRun: { findFirst }, sentimentFetchState: { findMany, upsert } },
}));

const getDynamicCandidateUniverse = vi.fn();
vi.mock("@/lib/agents/candidateUniverse", () => ({ getDynamicCandidateUniverse }));

const {
  selectSymbolsToFetch,
  fetchNewsSentimentScore,
  refreshNewsSentimentScores,
  getNewsSentimentScores,
  DAILY_FETCH_QUOTA,
} = await import("@/lib/agents/newsSentimentScore");
const { STATIC_CANDIDATE_UNIVERSE } = await import("@/lib/agents/candidateScanner");

const staticSymbols = Object.values(STATIC_CANDIDATE_UNIVERSE).flatMap((sector) => sector.symbols);

function scannerRun(symbols: string[]) {
  return { output: { topCandidates: symbols.map((symbol) => ({ symbol })) } };
}

const originalFetch = global.fetch;
const originalApiKey = process.env.ALPHA_VANTAGE_API_KEY;

afterEach(() => {
  vi.restoreAllMocks();
  global.fetch = originalFetch;
  process.env.ALPHA_VANTAGE_API_KEY = originalApiKey;
  findFirst.mockReset();
  findMany.mockReset();
  upsert.mockReset();
  getDynamicCandidateUniverse.mockReset();
});

describe("selectSymbolsToFetch", () => {
  it("pulls the latest Top 15 first, then the rest of the dynamic universe, before touching the static list", async () => {
    findFirst.mockResolvedValueOnce(scannerRun(["DELL", "PANW", "VLO"]));
    getDynamicCandidateUniverse.mockResolvedValueOnce({
      Technology: { sectorEtf: "XLK", symbols: ["DELL", "PANW", "VLO", "CRWD", "MU"] },
    });
    findMany.mockResolvedValueOnce([]);

    const result = await selectSymbolsToFetch(4);
    expect(result).toEqual(["DELL", "PANW", "VLO", "CRWD"]);
  });

  it("reaches the static tier only once every dynamic-universe symbol is placed", async () => {
    findFirst.mockResolvedValueOnce(scannerRun(["DELL"]));
    getDynamicCandidateUniverse.mockResolvedValueOnce({
      Technology: { sectorEtf: "XLK", symbols: ["DELL", "MU"] },
    });
    findMany.mockResolvedValueOnce([]);

    const result = await selectSymbolsToFetch(3);
    expect(result[0]).toBe("DELL");
    expect(result[1]).toBe("MU");
    expect(staticSymbols).toContain(result[2]);
  });

  it("keeps never-fetched-first / oldest-fetched-first staleness ordering within a tier", async () => {
    findFirst.mockResolvedValueOnce(scannerRun(["AMD", "MU", "DELL"]));
    getDynamicCandidateUniverse.mockResolvedValueOnce({ Technology: { sectorEtf: "XLK", symbols: ["AMD", "MU", "DELL"] } });
    findMany.mockResolvedValueOnce([
      { symbol: "AMD", lastFetchedAt: new Date("2020-01-01") },
      { symbol: "MU", lastFetchedAt: new Date("2020-01-05") },
      // DELL never fetched (no row) -> should sort first
    ]);

    const result = await selectSymbolsToFetch(3);
    expect(result).toEqual(["DELL", "AMD", "MU"]);
  });

  it("treats a symbol as stale only after ~5 days since its last successful fetch", async () => {
    findFirst.mockResolvedValueOnce(scannerRun(["RECENT", "OLD"]));
    getDynamicCandidateUniverse.mockResolvedValueOnce({
      Technology: { sectorEtf: "XLK", symbols: ["RECENT", "OLD"] },
    });
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    findMany.mockResolvedValueOnce([
      { symbol: "RECENT", lastFetchedAt: oneDayAgo },
      { symbol: "OLD", lastFetchedAt: sixDaysAgo },
    ]);

    const result = await selectSymbolsToFetch(1);
    expect(result).toEqual(["OLD"]);
  });

  it("a symbol in both the Top 15 and the dynamic universe only appears once, at its highest-priority slot", async () => {
    findFirst.mockResolvedValueOnce(scannerRun(["DELL"]));
    getDynamicCandidateUniverse.mockResolvedValueOnce({
      Technology: { sectorEtf: "XLK", symbols: ["DELL", "MU"] },
    });
    findMany.mockResolvedValueOnce([]);

    const result = await selectSymbolsToFetch(2);
    expect(result.filter((s) => s === "DELL")).toHaveLength(1);
    expect(result).toEqual(["DELL", "MU"]);
  });
});

function mockFetchResponse(body: unknown, ok = true): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Internal Server Error",
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe("fetchNewsSentimentScore", () => {
  it("returns an error when ALPHA_VANTAGE_API_KEY is not configured", async () => {
    delete process.env.ALPHA_VANTAGE_API_KEY;
    const result = await fetchNewsSentimentScore("AAPL");
    expect(result).toMatchObject({ status: "error" });
  });

  it("returns no_coverage for an empty feed", async () => {
    process.env.ALPHA_VANTAGE_API_KEY = "test-key";
    mockFetchResponse({ feed: [] });
    const result = await fetchNewsSentimentScore("AAPL");
    expect(result).toEqual({ status: "no_coverage" });
  });

  it("returns no_coverage when the feed has no usable ticker_sentiment entry for this symbol", async () => {
    process.env.ALPHA_VANTAGE_API_KEY = "test-key";
    mockFetchResponse({
      feed: [
        { title: "Unrelated", ticker_sentiment: [{ ticker: "MSFT", relevance_score: "0.5", ticker_sentiment_score: "0.2" }] },
      ],
    });
    const result = await fetchNewsSentimentScore("AAPL");
    expect(result).toEqual({ status: "no_coverage" });
  });

  it("excludes below-relevance-floor mentions from the weighted average", async () => {
    process.env.ALPHA_VANTAGE_API_KEY = "test-key";
    mockFetchResponse({
      feed: [
        { title: "A", ticker_sentiment: [{ ticker: "AAPL", relevance_score: "0.05", ticker_sentiment_score: "-0.9" }] },
        { title: "B", ticker_sentiment: [{ ticker: "AAPL", relevance_score: "0.8", ticker_sentiment_score: "0.4" }] },
      ],
    });
    const result = await fetchNewsSentimentScore("AAPL");
    expect(result.status).toBe("covered");
    if (result.status === "covered") {
      expect(result.articleCount).toBe(1);
      // Only the 0.8-relevance / 0.4-sentiment article counts: rawScore 0.4 -> (0.4+1)/2*100 = 70
      expect(result.score).toBe(70);
    }
  });

  it("computes a relevance-weighted average across multiple articles", async () => {
    process.env.ALPHA_VANTAGE_API_KEY = "test-key";
    mockFetchResponse({
      feed: [
        { title: "A", ticker_sentiment: [{ ticker: "AAPL", relevance_score: "0.5", ticker_sentiment_score: "0.2" }] },
        { title: "B", ticker_sentiment: [{ ticker: "AAPL", relevance_score: "0.5", ticker_sentiment_score: "-0.2" }] },
      ],
    });
    const result = await fetchNewsSentimentScore("AAPL");
    expect(result.status).toBe("covered");
    if (result.status === "covered") {
      expect(result.articleCount).toBe(2);
      // Equal weights, opposite sign -> weighted average 0 -> score 50 (neutral midpoint)
      expect(result.score).toBe(50);
    }
  });

  it("clamps an extreme raw sentiment score before rescaling", async () => {
    process.env.ALPHA_VANTAGE_API_KEY = "test-key";
    mockFetchResponse({
      feed: [{ title: "A", ticker_sentiment: [{ ticker: "AAPL", relevance_score: "1.0", ticker_sentiment_score: "5.0" }] }],
    });
    const result = await fetchNewsSentimentScore("AAPL");
    expect(result).toMatchObject({ status: "covered", score: 100 });
  });

  it("treats a Note/Information field as a rate-limit error, not real data", async () => {
    process.env.ALPHA_VANTAGE_API_KEY = "test-key";
    mockFetchResponse({ Note: "Thank you for using Alpha Vantage! Our standard API rate limit is..." });
    const result = await fetchNewsSentimentScore("AAPL");
    expect(result).toMatchObject({ status: "error" });
  });

  it("returns an error on a non-ok HTTP response", async () => {
    process.env.ALPHA_VANTAGE_API_KEY = "test-key";
    mockFetchResponse({}, false);
    const result = await fetchNewsSentimentScore("AAPL");
    expect(result).toMatchObject({ status: "error" });
  });
});

describe("refreshNewsSentimentScores", () => {
  it("persists a covered fetch with hasCoverage true and both lastFetchedAt/lastAttemptedAt updated", async () => {
    process.env.ALPHA_VANTAGE_API_KEY = "test-key";
    findFirst.mockResolvedValueOnce(scannerRun(["AAPL"]));
    getDynamicCandidateUniverse.mockResolvedValueOnce({});
    findMany.mockResolvedValueOnce([]);
    mockFetchResponse({
      feed: [{ title: "A", ticker_sentiment: [{ ticker: "AAPL", relevance_score: "0.8", ticker_sentiment_score: "0.5" }] }],
    });
    upsert.mockResolvedValueOnce({});

    const results = await refreshNewsSentimentScores(1);
    expect(results).toEqual([{ symbol: "AAPL", status: "covered", score: 75, articleCount: 1 }]);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { symbol: "AAPL" },
        update: expect.objectContaining({ hasCoverage: true, score: 75, articleCount: 1 }),
      }),
    );
  });

  it("persists a no_coverage result without clobbering hasCoverage as an error", async () => {
    process.env.ALPHA_VANTAGE_API_KEY = "test-key";
    findFirst.mockResolvedValueOnce(scannerRun(["ZZZ"]));
    getDynamicCandidateUniverse.mockResolvedValueOnce({});
    findMany.mockResolvedValueOnce([]);
    mockFetchResponse({ feed: [] });
    upsert.mockResolvedValueOnce({});

    const results = await refreshNewsSentimentScores(1);
    expect(results).toEqual([{ symbol: "ZZZ", status: "no_coverage" }]);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ hasCoverage: false, score: null }) }),
    );
  });

  it("records lastAttemptedAt on failure without setting lastFetchedAt, so a failed attempt doesn't look freshly refreshed", async () => {
    delete process.env.ALPHA_VANTAGE_API_KEY;
    findFirst.mockResolvedValueOnce(scannerRun(["AAPL"]));
    getDynamicCandidateUniverse.mockResolvedValueOnce({});
    findMany.mockResolvedValueOnce([]);
    upsert.mockResolvedValueOnce({});

    const results = await refreshNewsSentimentScores(1);
    expect(results).toEqual([{ symbol: "AAPL", status: "error", error: expect.any(String) }]);
    const updateArg = upsert.mock.calls[0][0].update;
    expect(updateArg.lastFetchedAt).toBeUndefined();
    expect(updateArg.lastAttemptedAt).toBeInstanceOf(Date);
  });

  it("respects DAILY_FETCH_QUOTA as the default quota", () => {
    expect(DAILY_FETCH_QUOTA).toBeGreaterThan(0);
  });
});

describe("getNewsSentimentScores", () => {
  it("reports not_yet_fetched for a symbol with no fetch-state row", async () => {
    findMany.mockResolvedValueOnce([]);
    const result = await getNewsSentimentScores(["NEVER"]);
    expect(result.get("NEVER")).toEqual({ symbol: "NEVER", score: null, coverage: "not_yet_fetched", articleCount: null, lastFetchedAt: null });
  });

  it("reports no_coverage when fetched but hasCoverage is false", async () => {
    const lastFetchedAt = new Date("2026-09-01");
    findMany.mockResolvedValueOnce([
      { symbol: "NOCOV", hasCoverage: false, score: null, articleCount: null, lastFetchedAt, lastAttemptedAt: lastFetchedAt, lastErrorMessage: null },
    ]);
    const result = await getNewsSentimentScores(["NOCOV"]);
    expect(result.get("NOCOV")).toMatchObject({ score: null, coverage: "no_coverage" });
  });

  it("reports the persisted score with coverage 'scored' when covered", async () => {
    const lastFetchedAt = new Date("2026-09-01");
    findMany.mockResolvedValueOnce([
      { symbol: "AAPL", hasCoverage: true, score: 72, articleCount: 5, lastFetchedAt, lastAttemptedAt: lastFetchedAt, lastErrorMessage: null },
    ]);
    const result = await getNewsSentimentScores(["AAPL"]);
    expect(result.get("AAPL")).toEqual({ symbol: "AAPL", score: 72, coverage: "scored", articleCount: 5, lastFetchedAt });
  });
});
