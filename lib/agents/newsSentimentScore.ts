import { prisma } from "@/lib/prisma";
import { getDynamicCandidateUniverse } from "@/lib/agents/candidateUniverse";
import { STATIC_CANDIDATE_UNIVERSE, type CandidateScannerOutput } from "@/lib/agents/candidateScanner";

/**
 * Alpha Vantage NEWS_SENTIMENT-backed news sentiment factor — scored and
 * persisted for validation, but deliberately NOT wired into the composite
 * score yet (see the dated note in scoringShared.ts). We already killed one
 * factor (EARNINGS_ESTIMATES, 2026-08-06) for near-zero real coverage after
 * trusting it too early; this module exists to accumulate enough real
 * history for the Performance Analyst (lib/agents/performanceAnalyst.ts) to
 * judge whether sentiment is actually predictive before it ever touches
 * candidateScanner.ts's or monthlyScan.ts's score formula.
 *
 * Distinct from lib/agents/newsSentiment.ts, which is a separate Claude +
 * web-search qualitative feature for the weekly brief's "News & Sentiment
 * Watch" — that one is human-facing prose, never a scoring input, and is
 * untouched by this module.
 */

/**
 * How many symbols to fetch per cron invocation: the whole candidate
 * universe, so every symbol refreshes daily. 120 = 81 dynamic (Energy 21,
 * Healthcare 30, Technology 30) + 39 static unique symbols as of 2026-10-06
 * (premium Alpha Vantage key assumed). At 1.2s pacing plus ~0.1s fetch and a
 * DB upsert, that is ~170s of the cron's 240s maxDuration. If the universe
 * grows past this, the oldest-first rotation just defers the tail a day.
 */
export const DAILY_FETCH_QUOTA = 120;

/**
 * Minimum hours between refetches for a symbol that's already been
 * successfully fetched. Material news can happen anytime, so every symbol
 * refreshes on each daily run; 20h (not 24h) so ordinary cron-time drift
 * can't make a symbol miss a day.
 */
const REFETCH_INTERVAL_HOURS = 20;
const REFETCH_INTERVAL_MS = REFETCH_INTERVAL_HOURS * 60 * 60 * 1000;

/** Stop fetching new symbols after this long so a slow run ends cleanly inside the cron's 240s maxDuration; unfetched symbols are first in line (oldest-first) next run. */
const REFRESH_TIME_BUDGET_MS = 225_000;

/** Alpha Vantage's free tier rejects requests faster than 1/second; kept unchanged even on the premium key (see earningsHistory.ts's identical constant/rationale). */
const MIN_REQUEST_INTERVAL_MS = 1200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Symbols from the latest completed Candidate Scanner run's Top 15 — same
 * priority signal earningsHistory.ts uses, kept as its own (small,
 * intentional) duplication here rather than importing a private helper from
 * that module, since newsSentimentScore.ts is meant to be a fully
 * independent, separately-testable pipeline.
 */
async function getLatestTopCandidateSymbols(): Promise<string[]> {
  const run = await prisma.agentRun.findFirst({
    where: { agentType: "CANDIDATE_SCANNER", status: "COMPLETE" },
    orderBy: { startedAt: "desc" },
  });
  if (!run?.output) return [];
  const output = run.output as unknown as CandidateScannerOutput;
  return output.topCandidates.map((c) => c.symbol);
}

/**
 * Builds this cron's fetch-priority tiers, highest first — same three-tier
 * shape as earningsHistory.ts's buildPriorityTiers: (1) the latest Top 15,
 * (2) the rest of the dynamic universe, (3) the static sector list. A symbol
 * that appears in more than one tier keeps only its highest-priority slot.
 */
async function buildPriorityTiers(): Promise<string[][]> {
  const [topCandidateSymbols, dynamicUniverse] = await Promise.all([
    getLatestTopCandidateSymbols(),
    getDynamicCandidateUniverse(),
  ]);
  const dynamicSymbols = Object.values(dynamicUniverse).flatMap((sector) => sector.symbols);
  const staticSymbols = Object.values(STATIC_CANDIDATE_UNIVERSE).flatMap((sector) => sector.symbols);

  const seen = new Set<string>();
  return [topCandidateSymbols, dynamicSymbols, staticSymbols].map((tier) =>
    tier.filter((symbol) => {
      if (seen.has(symbol)) return false;
      seen.add(symbol);
      return true;
    }),
  );
}

/**
 * Picks which symbols to fetch today — identical staleness/tiering logic to
 * earningsHistory.ts's selectSymbolsToFetch, just against
 * SentimentFetchState/REFETCH_INTERVAL_MS instead of EarningsFetchState.
 */
export async function selectSymbolsToFetch(quota: number = DAILY_FETCH_QUOTA): Promise<string[]> {
  const tiers = await buildPriorityTiers();
  const staleBefore = new Date(Date.now() - REFETCH_INTERVAL_MS);

  const states = await prisma.sentimentFetchState.findMany({
    where: { symbol: { in: tiers.flat() } },
    select: { symbol: true, lastFetchedAt: true },
  });
  const lastFetchedBySymbol = new Map(states.map((s) => [s.symbol, s.lastFetchedAt]));

  const staleOldestFirst = (tier: string[]): string[] => {
    const stale = tier.filter((symbol) => {
      const lastFetchedAt = lastFetchedBySymbol.get(symbol) ?? null;
      return lastFetchedAt == null || lastFetchedAt < staleBefore;
    });
    stale.sort((a, b) => {
      const aTime = lastFetchedBySymbol.get(a)?.getTime() ?? 0;
      const bTime = lastFetchedBySymbol.get(b)?.getTime() ?? 0;
      return aTime - bTime;
    });
    return stale;
  };

  return tiers.flatMap(staleOldestFirst).slice(0, quota);
}

const ALPHA_VANTAGE_BASE_URL = "https://www.alphavantage.co/query";

/**
 * Below this relevance_score, Alpha Vantage considers the ticker only a
 * passing mention in the article rather than a real subject of it — folding
 * those in would let low-relevance noise dilute a real signal, so they're
 * excluded from both the weighted average and articleCount entirely.
 */
const MIN_RELEVANCE_SCORE = 0.1;

/**
 * Alpha Vantage documents ticker_sentiment_score as roughly bounded to
 * [-1, 1.5] in practice (its own label bands top out at "Bullish" for
 * x >= 0.35), but published examples rarely exceed +-1. Clamping at 1
 * before rescaling to 0-100 matches the fixed-clamp-and-rescale pattern used
 * by every other sub-score in this composite (see earningsSurpriseTrend.ts's
 * RAW_SCORE_CEILING) rather than a cross-symbol normalization.
 */
const SENTIMENT_SCORE_CEILING = 1;

function parseAvNumber(value: string | undefined): number | null {
  if (value == null || value === "" || value === "None" || value === "-") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Maps a raw relevance-weighted average ticker_sentiment_score (roughly
 * -1..1) to a 0-100 scale, clamping first so an outlier article can't blow
 * past the scale.
 */
function rawSentimentToScore(raw: number): number {
  const clamped = Math.max(-SENTIMENT_SCORE_CEILING, Math.min(SENTIMENT_SCORE_CEILING, raw));
  return Math.round(((clamped + SENTIMENT_SCORE_CEILING) / (2 * SENTIMENT_SCORE_CEILING)) * 100);
}

interface RawTickerSentiment {
  ticker?: string;
  relevance_score?: string;
  ticker_sentiment_score?: string;
  ticker_sentiment_label?: string;
}

interface RawFeedItem {
  title?: string;
  time_published?: string;
  ticker_sentiment?: RawTickerSentiment[];
}

interface RawSentimentResponse {
  items?: string;
  feed?: RawFeedItem[];
  Note?: string;
  Information?: string;
}

export type NewsSentimentFetchResult =
  | { status: "covered"; score: number; articleCount: number }
  /** Alpha Vantage returned an empty `feed`, or a non-empty feed with no usable (above-relevance-floor) ticker_sentiment entry for this symbol. */
  | { status: "no_coverage" }
  | { status: "error"; errorMessage: string };

/**
 * Fetches Alpha Vantage's NEWS_SENTIMENT endpoint for one symbol and reduces
 * its `feed` array to a single 0-100 relevance-weighted average sentiment
 * score. Weighting choice: each article's ticker_sentiment_score is weighted
 * by that same article's relevance_score for this ticker before averaging
 * (a weighted mean, not a simple mean) — an article that's only tangentially
 * about this symbol (low relevance) shouldn't move the score as much as one
 * that's squarely about it (high relevance), and Alpha Vantage's own
 * relevance_score is exactly the field designed to make that distinction.
 */
export async function fetchNewsSentimentScore(symbol: string): Promise<NewsSentimentFetchResult> {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) {
    return { status: "error", errorMessage: "ALPHA_VANTAGE_API_KEY is not configured" };
  }

  const url = `${ALPHA_VANTAGE_BASE_URL}?function=NEWS_SENTIMENT&tickers=${encodeURIComponent(symbol)}&apikey=${apiKey}`;
  let body: RawSentimentResponse;
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      return { status: "error", errorMessage: `Alpha Vantage request failed for ${symbol}: ${response.status} ${response.statusText}` };
    }
    body = await response.json();
  } catch (err) {
    return { status: "error", errorMessage: err instanceof Error ? err.message : String(err) };
  }

  if (body.Note || body.Information) {
    return { status: "error", errorMessage: body.Note ?? body.Information ?? "Alpha Vantage returned a rate-limit/info message instead of data" };
  }

  const feed = body.feed ?? [];
  if (feed.length === 0) {
    return { status: "no_coverage" };
  }

  let weightedSum = 0;
  let weightTotal = 0;
  let articleCount = 0;

  for (const item of feed) {
    for (const entry of item.ticker_sentiment ?? []) {
      if (entry.ticker !== symbol) continue;
      const relevance = parseAvNumber(entry.relevance_score);
      const sentiment = parseAvNumber(entry.ticker_sentiment_score);
      if (relevance == null || sentiment == null || relevance < MIN_RELEVANCE_SCORE) continue;
      weightedSum += relevance * sentiment;
      weightTotal += relevance;
      articleCount += 1;
    }
  }

  if (weightTotal === 0) {
    return { status: "no_coverage" };
  }

  return { status: "covered", score: rawSentimentToScore(weightedSum / weightTotal), articleCount };
}

export interface NewsSentimentRefreshResult {
  symbol: string;
  status: "covered" | "no_coverage" | "error";
  score?: number;
  articleCount?: number;
  error?: string;
}

/**
 * Fetches and persists SentimentFetchState rows for today's batch of stale
 * symbols (see selectSymbolsToFetch). Every attempt updates
 * lastAttemptedAt; only a successful fetch (covered or confirmed
 * no_coverage) updates lastFetchedAt, so a failed attempt doesn't make a
 * symbol look freshly refreshed and skip it for the rest of its refetch
 * window — same shape as refreshEarningsHistory in earningsHistory.ts.
 */
export async function refreshNewsSentimentScores(quota: number = DAILY_FETCH_QUOTA): Promise<NewsSentimentRefreshResult[]> {
  const symbols = await selectSymbolsToFetch(quota);
  const results: NewsSentimentRefreshResult[] = [];
  const startedAt = Date.now();

  for (let i = 0; i < symbols.length; i++) {
    if (Date.now() - startedAt > REFRESH_TIME_BUDGET_MS) break;
    if (i > 0) await sleep(MIN_REQUEST_INTERVAL_MS);
    const symbol = symbols[i];
    const result = await fetchNewsSentimentScore(symbol);
    const now = new Date();

    if (result.status === "error") {
      await prisma.sentimentFetchState.upsert({
        where: { symbol },
        create: { symbol, lastAttemptedAt: now, lastErrorMessage: result.errorMessage },
        update: { lastAttemptedAt: now, lastErrorMessage: result.errorMessage },
      });
      results.push({ symbol, status: "error", error: result.errorMessage });
      continue;
    }

    if (result.status === "no_coverage") {
      await prisma.sentimentFetchState.upsert({
        where: { symbol },
        create: { symbol, hasCoverage: false, score: null, articleCount: null, lastFetchedAt: now, lastAttemptedAt: now, lastErrorMessage: null },
        update: { hasCoverage: false, score: null, articleCount: null, lastFetchedAt: now, lastAttemptedAt: now, lastErrorMessage: null },
      });
      results.push({ symbol, status: "no_coverage" });
      continue;
    }

    await prisma.sentimentFetchState.upsert({
      where: { symbol },
      create: {
        symbol,
        hasCoverage: true,
        score: result.score,
        articleCount: result.articleCount,
        lastFetchedAt: now,
        lastAttemptedAt: now,
        lastErrorMessage: null,
      },
      update: {
        hasCoverage: true,
        score: result.score,
        articleCount: result.articleCount,
        lastFetchedAt: now,
        lastAttemptedAt: now,
        lastErrorMessage: null,
      },
    });

    results.push({ symbol, status: "covered", score: result.score, articleCount: result.articleCount });
  }

  return results;
}

export type NewsSentimentCoverage = "scored" | "no_coverage" | "not_yet_fetched";

export interface NewsSentimentScoreResult {
  symbol: string;
  /**
   * 0-100, or null when there's no real signal to report yet. Unlike
   * earningsSurpriseTrend.ts's neutral-50 fallback (needed because that
   * factor is live in the composite and every candidate needs a numeric
   * value), this factor isn't scored into anything yet — a null here is
   * more honest than a fabricated neutral value that a future reader might
   * mistake for a real "no signal" read.
   */
  score: number | null;
  coverage: NewsSentimentCoverage;
  articleCount: number | null;
  lastFetchedAt: Date | null;
}

/**
 * Batched lookup for a list of candidate symbols — one query regardless of
 * universe size, matching getEarningsSurpriseTrendScores's pattern. Symbols
 * with no fetch-state row at all fall back to coverage "not_yet_fetched".
 */
export async function getNewsSentimentScores(symbols: string[]): Promise<Map<string, NewsSentimentScoreResult>> {
  const states = await prisma.sentimentFetchState.findMany({ where: { symbol: { in: symbols } } });
  const stateBySymbol = new Map(states.map((s) => [s.symbol, s]));

  const result = new Map<string, NewsSentimentScoreResult>();
  for (const symbol of symbols) {
    const state = stateBySymbol.get(symbol);
    if (!state || state.lastFetchedAt == null) {
      result.set(symbol, { symbol, score: null, coverage: "not_yet_fetched", articleCount: null, lastFetchedAt: null });
    } else if (!state.hasCoverage || state.score == null) {
      result.set(symbol, { symbol, score: null, coverage: "no_coverage", articleCount: state.articleCount, lastFetchedAt: state.lastFetchedAt });
    } else {
      result.set(symbol, { symbol, score: state.score, coverage: "scored", articleCount: state.articleCount, lastFetchedAt: state.lastFetchedAt });
    }
  }
  return result;
}
