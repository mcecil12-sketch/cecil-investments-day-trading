import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import {
  buildTrackedPositions,
  groupIntoMonthlyRankings,
  returnOverWindow,
  computeRealizedPnl,
  groupIntoWeeklyBatches,
  type TrackedPosition,
} from "@/lib/agents/recommendationPerformance";
import { buildBandedMonthlyPositions } from "@/lib/agents/monthlyScanBanding";
import { getPriceHistory, type PricePoint } from "@/lib/agents/marketData";
import { resolvePortfolioBaseValue } from "@/lib/agents/positionSizing";

/**
 * Turns recommendationPerformance.ts's numeric outputs (real closed-position
 * P&L, not a re-derivation of it) into structured, narrative research: why
 * winners won, why losers failed, which sector/earnings-coverage setups
 * performed best, whether the composite entry score actually predicts
 * realized return, and — once lib/agents/newsSentimentScore.ts has a few
 * weeks of real data — whether sentiment shows any predictive signal.
 * Follows cio.ts's synthesis pattern: serialize computed numeric context to
 * JSON, send to Claude with a dedicated forced tool call, get structured
 * findings back. Runs on the CIO synthesis's weekly cadence (see
 * runAndPersistPerformanceAnalyst / synthesizeWeeklyBrief in runner.ts) —
 * this is research, not a real-time signal.
 */

/** Below this many closed positions, a Pearson correlation is noise, not signal — same "don't trust it before it's validated" caution as the EARNINGS_ESTIMATES postmortem (see scoringShared.ts). */
const MIN_CLOSED_POSITIONS_FOR_CORRELATION = 5;

/** How many best/worst closed positions to surface as "winners"/"losers" context for Claude. */
const TOP_N = 5;

/** Sentiment fetching only started 2026-09-28 (see newsSentimentScore.ts) — this many days of real fetch history must have accumulated before even asking Claude to look for a signal. */
const MIN_SENTIMENT_HISTORY_DAYS = 14;

/** Below this many covered symbols, any sentiment-vs-return read would be drawn from too small a cross-section to mean anything. */
const MIN_SENTIMENT_COVERED_SYMBOLS = 5;

/** Fragility is a hypothesis (see fragilityScore.ts) — no comparison is surfaced until at least this many monthly cycles have logged fragility data... */
const MIN_FRAGILITY_MONTHLY_CYCLES = 3;

/** ...and at least this many closed Group 3 positions carry it. Same fabrication-guard style as the sentiment sufficiency check above. */
const MIN_FRAGILITY_CLOSED_POSITIONS = 10;

export interface FragilityObservation {
  fragilityFlag: boolean;
  vol60d: number | null;
  /** Raw price return from entry to exit (decimal fraction) — the "forward return over the holding period". */
  forwardReturn: number;
}

export interface FragilityGroupStats {
  count: number;
  avgForwardReturn: number | null;
  /** Mean of forwardReturn / vol60d across positions with a positive vol60d. */
  avgReturnPerUnitVol: number | null;
}

export interface FragilityStats {
  monthlyCycles: number;
  closedPositionsWithData: number;
  flagged: FragilityGroupStats;
  unflagged: FragilityGroupStats;
}

export interface ClosedPositionSummary {
  symbol: string;
  sector: string | null;
  entryScore: number;
  entryDate: string;
  exitDate: string;
  holdingDays: number;
  /** Realized P&L (see computeRealizedPnl in recommendationPerformance.ts) expressed as a fraction of the simulated portfolio's base value, so it's comparable across positions regardless of conviction-band sizing. */
  realizedPnlPct: number;
  earningsSurpriseCoverage: string | null;
  vsSpxAtEntry: number | null;
}

export interface ScoreCorrelationResult {
  /** Pearson r between entryScore and realizedPnlPct across closed positions. Null below MIN_CLOSED_POSITIONS_FOR_CORRELATION — an insufficient-data guard, not a real zero correlation. */
  coefficient: number | null;
  sampleSize: number;
}

export interface GroupedReturnStat {
  key: string;
  count: number;
  avgRealizedPnlPct: number;
}

export interface PerformanceAnalystContext {
  group: "GROUP_1";
  totalPositions: number;
  closedPositions: number;
  openPositions: number;
  trackedSince: string | null;
  scoreCorrelation: ScoreCorrelationResult;
  winners: ClosedPositionSummary[];
  losers: ClosedPositionSummary[];
  sectorBreakdown: GroupedReturnStat[];
  earningsSurpriseCoverageBreakdown: GroupedReturnStat[];
  holdingDaysStats: { avgWinnerHoldingDays: number | null; avgLoserHoldingDays: number | null };
  /** True only once newsSentimentScore.ts has enough real fetch history (age + breadth) to make a sentiment-vs-return read meaningful — see MIN_SENTIMENT_HISTORY_DAYS/MIN_SENTIMENT_COVERED_SYMBOLS. */
  sentimentDataSufficient: boolean;
  sentimentCoveredSymbolCount: number;
  sentimentOldestFetchDaysAgo: number | null;
  /** Flagged-vs-unflagged fragility comparison over closed Group 3 positions. Null (not zeros) until MIN_FRAGILITY_MONTHLY_CYCLES and MIN_FRAGILITY_CLOSED_POSITIONS are both met — an insufficient-data guard, not a real result. */
  fragility: FragilityStats | null;
}

export interface PerformanceAnalystOutput {
  topWinnerPatterns: string[];
  topLoserPatterns: string[];
  bestSetupTypes: string[];
  scoreVsRealizedR: ScoreCorrelationResult;
  scoreVsRealizedRNote: string;
  earlyExitPatterns: string[];
  /** Null until sentimentDataSufficient is true — enforced in code (see synthesizePerformanceAnalysis), never trusted from Claude's own output alone. */
  sentimentSignalNote: string | null;
  /** Null until context.fragility is non-null — enforced in code (see synthesizePerformanceAnalysis). */
  fragilityNote: string | null;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Sample Pearson correlation coefficient. Null when either series has zero variance (a degenerate/undefined correlation) rather than dividing by zero. */
function pearsonCorrelation(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const meanX = average(xs)!;
  const meanY = average(ys)!;
  let numerator = 0;
  let denomX = 0;
  let denomY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  if (denomX === 0 || denomY === 0) return null;
  return numerator / Math.sqrt(denomX * denomY);
}

function groupAverageReturn(summaries: ClosedPositionSummary[], keyFn: (s: ClosedPositionSummary) => string): GroupedReturnStat[] {
  const byKey = new Map<string, number[]>();
  for (const summary of summaries) {
    const key = keyFn(summary);
    const list = byKey.get(key) ?? [];
    list.push(summary.realizedPnlPct);
    byKey.set(key, list);
  }
  return [...byKey.entries()]
    .map(([key, values]) => ({ key, count: values.length, avgRealizedPnlPct: average(values)! }))
    .sort((a, b) => b.avgRealizedPnlPct - a.avgRealizedPnlPct);
}

function fragilityGroupStats(observations: FragilityObservation[]): FragilityGroupStats {
  const perVol = observations.filter((o) => o.vol60d != null && o.vol60d > 0).map((o) => o.forwardReturn / o.vol60d!);
  return {
    count: observations.length,
    avgForwardReturn: average(observations.map((o) => o.forwardReturn)),
    avgReturnPerUnitVol: average(perVol),
  };
}

/**
 * Flagged-vs-unflagged comparison of closed positions that carry fragility
 * data. Returns null unless there are at least MIN_FRAGILITY_MONTHLY_CYCLES
 * cycles and MIN_FRAGILITY_CLOSED_POSITIONS observations — never zeros.
 */
export function computeFragilityStats(observations: FragilityObservation[], monthlyCycles: number): FragilityStats | null {
  if (monthlyCycles < MIN_FRAGILITY_MONTHLY_CYCLES || observations.length < MIN_FRAGILITY_CLOSED_POSITIONS) return null;
  return {
    monthlyCycles,
    closedPositionsWithData: observations.length,
    flagged: fragilityGroupStats(observations.filter((o) => o.fragilityFlag)),
    unflagged: fragilityGroupStats(observations.filter((o) => !o.fragilityFlag)),
  };
}

/** Group 3 (monthly) fragility stats from real closed positions. Never throws — fragility is research-only and must not break the analyst run. */
async function buildFragilityStats(): Promise<FragilityStats | null> {
  try {
    const rows = await prisma.candidateRecommendationLog.findMany({
      where: { group: "GROUP_3" },
      orderBy: { recommendedAt: "asc" },
    });
    const withData = rows.filter((r) => r.fragilityFlag != null);
    const monthlyCycles = new Set(withData.map((r) => r.batchTag)).size;
    if (monthlyCycles < MIN_FRAGILITY_MONTHLY_CYCLES) return null;

    const rowLookup = new Map(withData.map((r) => [`${r.symbol}@@${r.recommendedAt.getTime()}`, r]));
    const positions = buildBandedMonthlyPositions(
      groupIntoMonthlyRankings(rows.map((r) => ({ symbol: r.symbol, batchTag: r.batchTag, recommendedAt: r.recommendedAt, score: r.score, rank: r.rank }))),
    );
    const closed = positions.filter((p): p is typeof p & { exitDate: Date } => p.exitDate != null);

    const observations: FragilityObservation[] = [];
    await Promise.all(
      closed.map(async (position) => {
        const row = rowLookup.get(`${position.symbol}@@${position.entryDate.getTime()}`);
        if (!row || row.fragilityFlag == null) return;
        try {
          const { points } = await getPriceHistory(position.symbol);
          const forwardReturn = returnOverWindow(points, position.entryDate, position.exitDate);
          if (forwardReturn == null) return;
          observations.push({ fragilityFlag: row.fragilityFlag, vol60d: row.vol60d, forwardReturn });
        } catch {
          // Skip — this position just won't contribute until its price history is fetchable again.
        }
      }),
    );
    return computeFragilityStats(observations, monthlyCycles);
  } catch {
    return null;
  }
}

const EMPTY_CONTEXT: PerformanceAnalystContext = {
  group: "GROUP_1",
  totalPositions: 0,
  closedPositions: 0,
  openPositions: 0,
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
};

/**
 * Builds the JSON context Claude sees, entirely from real data: closed Top
 * 15 (GROUP_1) positions replayed through the exact same
 * buildTrackedPositions/computeRealizedPnl logic recommendationPerformance.ts
 * uses for the Dashboard's own performance views — no independent
 * re-derivation of P&L math here, just aggregation on top of it.
 */
export async function buildPerformanceAnalystContext(totalCurrentValue?: number | null): Promise<PerformanceAnalystContext> {
  const rows = await prisma.candidateRecommendationLog.findMany({
    where: { group: "GROUP_1" },
    orderBy: { recommendedAt: "asc" },
  });
  if (rows.length === 0) return EMPTY_CONTEXT;

  const baseValue = resolvePortfolioBaseValue(totalCurrentValue);

  // All rows from one scan share the exact same recommendedAt timestamp
  // (see logCandidateRecommendationBatch), so (symbol, recommendedAt) is a
  // reliable key back to the original row's sector/vsSpx/earnings-coverage
  // for whichever batch became a position's entryDate.
  const rowLookup = new Map<string, (typeof rows)[number]>();
  for (const row of rows) rowLookup.set(`${row.symbol}@@${row.recommendedAt.getTime()}`, row);

  const batches = groupIntoWeeklyBatches(
    rows.map((r) => ({ symbol: r.symbol, batchTag: r.batchTag, recommendedAt: r.recommendedAt, score: r.score })),
  );
  const positions = buildTrackedPositions(batches);
  const closed = positions.filter((p): p is TrackedPosition & { exitDate: Date } => p.exitDate != null);
  const open = positions.filter((p) => p.exitDate == null);

  const uniqueSymbols = [...new Set(closed.map((p) => p.symbol))];
  const priceBySymbol = new Map<string, PricePoint[]>();
  await Promise.all(
    uniqueSymbols.map(async (symbol) => {
      try {
        const { points } = await getPriceHistory(symbol);
        priceBySymbol.set(symbol, points);
      } catch {
        // Skip — this position just won't contribute to the stats below until its price history is fetchable again.
      }
    }),
  );

  const summaries: ClosedPositionSummary[] = [];
  for (const position of closed) {
    const realizedPnl = computeRealizedPnl(position, priceBySymbol, baseValue);
    if (realizedPnl == null) continue;
    const entryRow = rowLookup.get(`${position.symbol}@@${position.entryDate.getTime()}`);
    const holdingDays = Math.round((position.exitDate.getTime() - position.entryDate.getTime()) / (24 * 60 * 60 * 1000));
    summaries.push({
      symbol: position.symbol,
      sector: entryRow?.sector ?? null,
      entryScore: position.entryScore,
      entryDate: position.entryDate.toISOString(),
      exitDate: position.exitDate.toISOString(),
      holdingDays,
      realizedPnlPct: realizedPnl / baseValue,
      earningsSurpriseCoverage: entryRow?.earningsSurpriseCoverage ?? null,
      vsSpxAtEntry: entryRow?.vsSpx ?? null,
    });
  }

  const scoreCorrelation: ScoreCorrelationResult = {
    coefficient:
      summaries.length >= MIN_CLOSED_POSITIONS_FOR_CORRELATION
        ? pearsonCorrelation(summaries.map((s) => s.entryScore), summaries.map((s) => s.realizedPnlPct))
        : null,
    sampleSize: summaries.length,
  };

  const byReturnDesc = [...summaries].sort((a, b) => b.realizedPnlPct - a.realizedPnlPct);
  const winners = byReturnDesc.slice(0, TOP_N);
  const losers = byReturnDesc.slice(-TOP_N).reverse();

  const sectorBreakdown = groupAverageReturn(summaries, (s) => s.sector ?? "Unclassified");
  const earningsSurpriseCoverageBreakdown = groupAverageReturn(summaries, (s) => s.earningsSurpriseCoverage ?? "unknown");

  const winnerHoldingDays = summaries.filter((s) => s.realizedPnlPct > 0).map((s) => s.holdingDays);
  const loserHoldingDays = summaries.filter((s) => s.realizedPnlPct <= 0).map((s) => s.holdingDays);

  const sentimentStates = await prisma.sentimentFetchState.findMany({ where: { hasCoverage: true } });
  const oldestFetch = sentimentStates.reduce<Date | null>((oldest, s) => {
    if (s.lastFetchedAt == null) return oldest;
    return oldest == null || s.lastFetchedAt < oldest ? s.lastFetchedAt : oldest;
  }, null);
  const sentimentOldestFetchDaysAgo =
    oldestFetch == null ? null : Math.floor((Date.now() - oldestFetch.getTime()) / (24 * 60 * 60 * 1000));
  const sentimentDataSufficient =
    sentimentStates.length >= MIN_SENTIMENT_COVERED_SYMBOLS &&
    sentimentOldestFetchDaysAgo != null &&
    sentimentOldestFetchDaysAgo >= MIN_SENTIMENT_HISTORY_DAYS;

  return {
    group: "GROUP_1",
    totalPositions: positions.length,
    closedPositions: closed.length,
    openPositions: open.length,
    trackedSince: positions[0]?.entryDate.toISOString() ?? null,
    scoreCorrelation,
    winners,
    losers,
    sectorBreakdown,
    earningsSurpriseCoverageBreakdown,
    holdingDaysStats: { avgWinnerHoldingDays: average(winnerHoldingDays), avgLoserHoldingDays: average(loserHoldingDays) },
    sentimentDataSufficient,
    sentimentCoveredSymbolCount: sentimentStates.length,
    sentimentOldestFetchDaysAgo,
    fragility: await buildFragilityStats(),
  };
}

const SYSTEM_PROMPT = `You are the Performance Analyst for a household investment portfolio's autonomous scoring/recommendation system. You're given structured numeric data (JSON), already computed from real trade history: closed "Top 15" candidate positions (a rules-based weekly composite score at entry, entry/exit dates, realized return expressed as a fraction of the simulated portfolio's base value), grouped by sector and by earnings-surprise-trend data coverage, plus a pre-computed Pearson correlation between the composite entry score and each position's realized return.

Turn this into concise, structured research findings:
1. topWinnerPatterns / topLoserPatterns: 2-4 short bullet-style observations about what the entries in "winners"/"losers" have in common (sector, earnings coverage, vsSpx at entry, holding period) — cite concrete symbols/numbers from the data given. Never invent a fact not present in the JSON.
2. bestSetupTypes: 1-3 short observations naming which sector/earnings-coverage groups in sectorBreakdown/earningsSurpriseCoverageBreakdown show the strongest average realized return, citing the actual avgRealizedPnlPct and count.
3. scoreVsRealizedRNote: 1-2 sentences interpreting the ALREADY-COMPUTED correlation given in scoreCorrelation (coefficient, sampleSize) — do not compute or invent a different coefficient. If sampleSize is below 5, say plainly there isn't enough closed-position history yet to judge the score's predictive power, rather than reading anything into so few data points.
4. earlyExitPatterns: 1-3 short observations from holdingDaysStats and the losers list about whether short holding periods correlate with worse outcomes.
5. sentimentSignalNote: the data includes sentimentDataSufficient (boolean) plus sentimentCoveredSymbolCount/sentimentOldestFetchDaysAgo. If sentimentDataSufficient is false, you MUST return an empty string "" for this field — there is not yet enough real sentiment-score fetch history to say anything about whether it predicts returns, and guessing from insufficient data would be fabricating a signal that doesn't exist. Only when sentimentDataSufficient is true, and only from sentiment data actually present in the JSON, may you attempt a real observation.

6. fragilityNote: the data includes fragility, either null or a flagged-vs-unflagged comparison (avgForwardReturn and avgReturnPerUnitVol per group) over closed monthly-scan positions. Fragility is an unproven hypothesis. If fragility is null, you MUST return an empty string "" for this field — there is not yet enough history, and asserting any conclusion would be fabrication. If it is present, describe only the numbers given and say whether they are consistent with the hypothesis that flagged names underperform; do not claim it is validated or recommend changing the score.

Base every claim strictly on the JSON data provided. Never invent dollar amounts, correlations, or symbols not present in the data.`;

const ANALYSIS_TOOL: Anthropic.Tool = {
  name: "submit_performance_analysis",
  description: "Submit the structured Performance Analyst research findings.",
  input_schema: {
    type: "object",
    properties: {
      topWinnerPatterns: {
        type: "array",
        items: { type: "string" },
        description: "2-4 short observations about what the top winners have in common.",
      },
      topLoserPatterns: {
        type: "array",
        items: { type: "string" },
        description: "2-4 short observations about what the top losers have in common.",
      },
      bestSetupTypes: {
        type: "array",
        items: { type: "string" },
        description: "1-3 short observations naming the best-performing sector/earnings-coverage combinations.",
      },
      scoreVsRealizedRNote: {
        type: "string",
        description: "1-2 sentence interpretation of the given (not recomputed) score-vs-realized-return correlation.",
      },
      earlyExitPatterns: {
        type: "array",
        items: { type: "string" },
        description: "1-3 short observations about holding period vs. outcome.",
      },
      sentimentSignalNote: {
        type: "string",
        description:
          "Empty string \"\" if sentimentDataSufficient is false. Otherwise a real observation grounded strictly in the sentiment data given.",
      },
      fragilityNote: {
        type: "string",
        description:
          "Empty string \"\" if fragility is null. Otherwise a neutral description of the given flagged-vs-unflagged numbers, with no validation claim.",
      },
    },
    required: [
      "topWinnerPatterns",
      "topLoserPatterns",
      "bestSetupTypes",
      "scoreVsRealizedRNote",
      "earlyExitPatterns",
      "sentimentSignalNote",
      "fragilityNote",
    ],
  },
};

function fallbackOutput(context: PerformanceAnalystContext): PerformanceAnalystOutput {
  return {
    topWinnerPatterns: [],
    topLoserPatterns: [],
    bestSetupTypes: [],
    scoreVsRealizedR: context.scoreCorrelation,
    scoreVsRealizedRNote:
      context.scoreCorrelation.sampleSize < MIN_CLOSED_POSITIONS_FOR_CORRELATION
        ? `Only ${context.scoreCorrelation.sampleSize} closed position(s) tracked so far — not enough history yet to judge whether the composite score predicts realized return.`
        : "Automatic synthesis is unavailable right now.",
    earlyExitPatterns: [],
    sentimentSignalNote: null,
    fragilityNote: null,
  };
}

/**
 * Sends the computed performance context to Claude for narrative synthesis
 * (see cio.ts's identical synthesize-then-fall-back-on-failure shape). Falls
 * back to a deterministic, no-fabrication output if there are no closed
 * positions yet, ANTHROPIC_API_KEY is missing, or the API call fails.
 *
 * sentimentSignalNote is forced to null in code whenever
 * context.sentimentDataSufficient is false, regardless of what Claude
 * returns — the prompt asks Claude to self-police this, but the guarantee
 * that this pipeline never surfaces a fabricated sentiment correlation
 * before there's enough real data doesn't depend on the model following
 * instructions.
 */
export async function synthesizePerformanceAnalysis(context: PerformanceAnalystContext): Promise<PerformanceAnalystOutput> {
  if (context.closedPositions === 0) return fallbackOutput(context);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fallbackOutput(context);

  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools: [ANALYSIS_TOOL],
    tool_choice: { type: "tool", name: "submit_performance_analysis" },
    messages: [{ role: "user", content: JSON.stringify(context, null, 2) }],
  });

  const toolUse = message.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
  if (!toolUse) {
    throw new Error("Claude didn't return a structured performance analysis");
  }

  const input = toolUse.input as {
    topWinnerPatterns: string[];
    topLoserPatterns: string[];
    bestSetupTypes: string[];
    scoreVsRealizedRNote: string;
    earlyExitPatterns: string[];
    sentimentSignalNote: string;
    fragilityNote?: string;
  };

  return {
    topWinnerPatterns: input.topWinnerPatterns,
    topLoserPatterns: input.topLoserPatterns,
    bestSetupTypes: input.bestSetupTypes,
    scoreVsRealizedR: context.scoreCorrelation,
    scoreVsRealizedRNote: input.scoreVsRealizedRNote,
    earlyExitPatterns: input.earlyExitPatterns,
    sentimentSignalNote: context.sentimentDataSufficient ? input.sentimentSignalNote?.trim() || null : null,
    fragilityNote: context.fragility ? input.fragilityNote?.trim() || null : null,
  };
}

/** Builds the context and synthesizes in one call — what runAndPersistPerformanceAnalyst (runner.ts) invokes. */
export async function runPerformanceAnalyst(totalCurrentValue?: number | null): Promise<PerformanceAnalystOutput> {
  const context = await buildPerformanceAnalystContext(totalCurrentValue);
  return synthesizePerformanceAnalysis(context);
}
