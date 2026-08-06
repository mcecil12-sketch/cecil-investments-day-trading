import { prisma } from "@/lib/prisma";
import { getDynamicCandidateUniverse } from "@/lib/agents/candidateUniverse";
import { STATIC_CANDIDATE_UNIVERSE, type CandidateScannerOutput } from "@/lib/agents/candidateScanner";

/** How many symbols to fetch per cron invocation. Kept unchanged from the prior EARNINGS_ESTIMATES-based pipeline for now — EARNINGS has full coverage and we're on an Alpha Vantage premium key with no daily cap, so fetching the whole universe in one run may be possible, but that's a separate rotation-design decision, not part of this factor/data-source swap. */
export const DAILY_FETCH_QUOTA = 20;

/**
 * Minimum days between refetches for a symbol that's already been
 * successfully fetched. Earnings are reported quarterly (~91 days apart);
 * 80 gives an ~11-day margin so a symbol becomes eligible again shortly
 * before its next quarter would typically be due, rather than exactly on
 * it (real reporting dates vary a bit quarter to quarter). Replaces the
 * prior per-ISO-week rule, which was calibrated for EARNINGS_ESTIMATES'
 * forward-looking analyst estimates (those do move week to week); reported
 * quarterly EPS history can't change more than once a quarter, so refetching
 * weekly was pure waste once a symbol had already been covered.
 */
const REFETCH_INTERVAL_DAYS = 80;
const REFETCH_INTERVAL_MS = REFETCH_INTERVAL_DAYS * 24 * 60 * 60 * 1000;

/**
 * Symbols from the latest completed Candidate Scanner run's Top 15
 * ("Highest Conviction Opportunities") — these are actively driving real
 * recommendations right now, so they take fetch priority over the rest of
 * the universe. Empty if no Candidate Scanner run has completed yet.
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
 * Builds this cron's fetch-priority tiers, highest first:
 *  1. The latest Top 15 / Highest Conviction Opportunities symbols — these
 *     are actively driving real recommendations right now.
 *  2. The rest of the dynamic universe (Technology/Energy/Healthcare, the
 *     SSGA-derived ~39-ticker list — see candidateUniverse.ts), since that's
 *     the active candidate-scanning universe.
 *  3. The static sector list (Financials/Industrials/Communications/
 *     Consumer Discretionary/International Developed) — still worth
 *     eventually covering, but shouldn't block coverage of what's actually
 *     being scored and recommended.
 * A symbol that appears in more than one tier keeps only its
 * highest-priority slot.
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
 * Picks which symbols to fetch today. Symbols are first grouped into
 * priority tiers (see buildPriorityTiers); within each tier, the existing
 * staleness rule applies unchanged in shape — symbols never fetched at all
 * come first, then symbols not refetched within the trailing
 * REFETCH_INTERVAL_DAYS days, oldest-fetched first. Tiers are then
 * concatenated in priority order and capped at `quota`, so a later tier is
 * only reached once every stale symbol in every higher tier has been
 * included. A symbol still within its refetch window is left alone even if
 * a prior attempt on it failed earlier today — see lastAttemptedAt on
 * EarningsFetchState for that history.
 */
export async function selectSymbolsToFetch(quota: number = DAILY_FETCH_QUOTA): Promise<string[]> {
  const tiers = await buildPriorityTiers();
  const staleBefore = new Date(Date.now() - REFETCH_INTERVAL_MS);

  const states = await prisma.earningsFetchState.findMany({
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

interface RawQuarterlyEarningsRow {
  fiscalDateEnding?: string;
  reportedDate?: string;
  reportedEPS?: string;
  estimatedEPS?: string;
  surprise?: string;
  surprisePercentage?: string;
}

interface RawEarningsResponse {
  symbol?: string;
  quarterlyEarnings?: RawQuarterlyEarningsRow[];
  Note?: string;
  Information?: string;
}

/**
 * Parses an Alpha Vantage numeric string, treating missing/"None"/non-numeric
 * values as null rather than 0 — Alpha Vantage's own way of saying "no data
 * for this field," which is a different fact than "the value is zero."
 */
function parseAvNumber(value: string | undefined): number | null {
  if (value == null || value === "" || value === "None" || value === "-") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseAvDate(value: string | undefined): Date | null {
  if (value == null || value === "" || value === "None") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export interface EarningsHistoryQuarter {
  fiscalDateEnding: Date;
  reportedDate: Date | null;
  reportedEPS: number | null;
  estimatedEPS: number | null;
  surprise: number | null;
  surprisePercentage: number | null;
}

export type EarningsHistoryFetchResult =
  | { status: "covered"; quarters: EarningsHistoryQuarter[] }
  /** Alpha Vantage returned an empty `quarterlyEarnings` array — no reported earnings history at all for this symbol. */
  | { status: "no_coverage" }
  | { status: "error"; message: string };

const ALPHA_VANTAGE_BASE_URL = "https://www.alphavantage.co/query";

/**
 * How many of the most-recent quarters returned to persist per symbol.
 * Comfortably more than the 8 quarters the SUE calculation needs (see
 * earningsSurpriseTrend.ts) without storing a company's entire multi-decade
 * history — some symbols return 100+ quarters from this endpoint, confirmed
 * via live testing 2026-08-06 (e.g. WDC/MU/UNH each returned 122), which is
 * far more than the scoring window ever uses.
 */
const QUARTERS_TO_PERSIST = 12;

/**
 * Fetches Alpha Vantage's EARNINGS endpoint for one symbol and extracts the
 * most recent quarterlyEarnings rows. Replaces the prior EARNINGS_ESTIMATES
 * fetch (removed — see git history for the old earningsEstimates.ts) after
 * live testing confirmed 2026-08-06 that EARNINGS_ESTIMATES has near-zero real coverage
 * for this app's candidate universe (10/15 Top-15 symbols came back with an
 * empty `estimates` array) while EARNINGS returned real reported/estimated
 * EPS history for all 15.
 */
export async function fetchEarningsHistory(symbol: string): Promise<EarningsHistoryFetchResult> {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) {
    return { status: "error", message: "ALPHA_VANTAGE_API_KEY is not configured" };
  }

  const url = `${ALPHA_VANTAGE_BASE_URL}?function=EARNINGS&symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`;
  let body: RawEarningsResponse;
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      return { status: "error", message: `Alpha Vantage request failed for ${symbol}: ${response.status} ${response.statusText}` };
    }
    body = await response.json();
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }

  if (body.Note || body.Information) {
    return { status: "error", message: body.Note ?? body.Information ?? "Alpha Vantage returned a rate-limit/info message instead of data" };
  }

  const rows = body.quarterlyEarnings ?? [];
  if (rows.length === 0) {
    return { status: "no_coverage" };
  }

  const quarters: EarningsHistoryQuarter[] = [];
  for (const row of rows.slice(0, QUARTERS_TO_PERSIST)) {
    const fiscalDateEnding = parseAvDate(row.fiscalDateEnding);
    if (fiscalDateEnding == null) continue; // no fiscal quarter to key the upsert on
    quarters.push({
      fiscalDateEnding,
      reportedDate: parseAvDate(row.reportedDate),
      reportedEPS: parseAvNumber(row.reportedEPS),
      estimatedEPS: parseAvNumber(row.estimatedEPS),
      surprise: parseAvNumber(row.surprise),
      surprisePercentage: parseAvNumber(row.surprisePercentage),
    });
  }

  return { status: "covered", quarters };
}

export interface EarningsHistoryRefreshResult {
  symbol: string;
  status: "covered" | "no_coverage" | "error";
  quartersPersisted?: number;
  error?: string;
}

/** Alpha Vantage's free tier rejects requests faster than 1/second (see the original live test on 2026-07-29, still documented in git history for the prior EARNINGS_ESTIMATES fetcher). Kept unchanged even on the premium key — no downside to the pacing, and it keeps this cron well within its 60s maxDuration regardless of tier. */
const MIN_REQUEST_INTERVAL_MS = 1200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches and persists EarningsHistory + EarningsFetchState rows for today's
 * batch of stale symbols (see selectSymbolsToFetch). Every attempt updates
 * lastAttemptedAt; only a successful fetch (covered or confirmed no_coverage)
 * updates lastFetchedAt, so a failed attempt doesn't make a symbol look
 * freshly refreshed and skip it for the rest of the week.
 */
export async function refreshEarningsHistory(quota: number = DAILY_FETCH_QUOTA): Promise<EarningsHistoryRefreshResult[]> {
  const symbols = await selectSymbolsToFetch(quota);
  const results: EarningsHistoryRefreshResult[] = [];

  for (let i = 0; i < symbols.length; i++) {
    if (i > 0) await sleep(MIN_REQUEST_INTERVAL_MS);
    const symbol = symbols[i];
    const result = await fetchEarningsHistory(symbol);
    const now = new Date();

    if (result.status === "error") {
      await prisma.earningsFetchState.upsert({
        where: { symbol },
        create: { symbol, lastAttemptedAt: now, lastErrorMessage: result.message },
        update: { lastAttemptedAt: now, lastErrorMessage: result.message },
      });
      results.push({ symbol, status: "error", error: result.message });
      continue;
    }

    if (result.status === "no_coverage") {
      await prisma.earningsFetchState.upsert({
        where: { symbol },
        create: { symbol, hasHistory: false, lastFetchedAt: now, lastAttemptedAt: now, lastErrorMessage: null },
        update: { hasHistory: false, lastFetchedAt: now, lastAttemptedAt: now, lastErrorMessage: null },
      });
      results.push({ symbol, status: "no_coverage" });
      continue;
    }

    await Promise.all(
      result.quarters.map((q) =>
        prisma.earningsHistory.upsert({
          where: { symbol_fiscalDateEnding: { symbol, fiscalDateEnding: q.fiscalDateEnding } },
          create: {
            symbol,
            fiscalDateEnding: q.fiscalDateEnding,
            reportedDate: q.reportedDate,
            reportedEPS: q.reportedEPS,
            estimatedEPS: q.estimatedEPS,
            surprise: q.surprise,
            surprisePercentage: q.surprisePercentage,
          },
          update: {
            reportedDate: q.reportedDate,
            reportedEPS: q.reportedEPS,
            estimatedEPS: q.estimatedEPS,
            surprise: q.surprise,
            surprisePercentage: q.surprisePercentage,
          },
        }),
      ),
    );

    await prisma.earningsFetchState.upsert({
      where: { symbol },
      create: { symbol, hasHistory: true, lastFetchedAt: now, lastAttemptedAt: now, lastErrorMessage: null },
      update: { hasHistory: true, lastFetchedAt: now, lastAttemptedAt: now, lastErrorMessage: null },
    });

    results.push({ symbol, status: "covered", quartersPersisted: result.quarters.length });
  }

  return results;
}
