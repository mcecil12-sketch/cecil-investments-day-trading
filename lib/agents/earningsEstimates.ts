import { prisma } from "@/lib/prisma";
import { getDynamicCandidateUniverse } from "@/lib/agents/candidateUniverse";

/**
 * Static-sector tickers, duplicated from candidateScanner.ts's
 * STATIC_CANDIDATE_UNIVERSE rather than imported from it, because that file
 * is intentionally off-limits for this feature until the composite-weighting
 * decision (sentiment/news renormalization) is confirmed separately. Keep
 * this list in sync by hand for now; once candidateScanner.ts is safe to
 * touch, replace this with a shared export instead of two sources of truth.
 *
 * TODO: candidateScanner.ts's STATIC_CANDIDATE_UNIVERSE is the source of
 * truth this list mirrors — reconcile there (export it and import here)
 * instead of maintaining both once that file is touched again.
 */
const STATIC_SECTOR_SYMBOLS: string[] = [
  "BRK-B", "JPM", "V", "MA", "GS", "MS", "BAC", "AXP", "BX", "KKR",
  "CAT", "DE", "HON", "UPS", "RTX", "GE", "LMT", "ETN", "EMR", "PH",
  "GOOGL", "META", "NFLX", "DIS", "CMCSA", "T", "VZ", "TMUS",
  "AMZN", "TSLA", "HD", "MCD", "NKE", "SBUX", "TGT", "LOW",
  "EFA", "VEA", "VXUS",
];

/**
 * The full candidate universe (currently ~81 symbols): the static sectors
 * above, plus whatever's cached in CandidateUniverse for the SSGA-derived
 * dynamic sectors (Energy/Healthcare/Technology — see candidateUniverse.ts).
 * Deduped since a symbol could in principle appear in both a static sector
 * list and a dynamic sector's top holdings.
 */
export async function getFullCandidateSymbols(): Promise<string[]> {
  const dynamicUniverse = await getDynamicCandidateUniverse();
  const dynamicSymbols = Object.values(dynamicUniverse).flatMap((sector) => sector.symbols);
  return Array.from(new Set([...STATIC_SECTOR_SYMBOLS, ...dynamicSymbols]));
}

/** How many symbols to fetch per cron invocation — kept comfortably under Alpha Vantage's 25/day free-tier cap. */
export const DAILY_FETCH_QUOTA = 12;

const startOfIsoWeekUTC = (date: Date): Date => {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  const diff = (day === 0 ? -6 : 1) - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
};

/**
 * Picks which symbols to fetch today: prefers symbols never fetched at all,
 * then symbols not yet refreshed since the start of this ISO week (Monday
 * 00:00 UTC), oldest-fetched first, capped at `quota`. A symbol already
 * refreshed this week is left alone even if a prior attempt on it failed
 * earlier today — see lastAttemptedAt on the snapshot row for that history.
 */
export async function selectSymbolsToFetch(quota: number = DAILY_FETCH_QUOTA): Promise<string[]> {
  const universe = await getFullCandidateSymbols();
  const weekStart = startOfIsoWeekUTC(new Date());

  const snapshots = await prisma.earningsEstimateSnapshot.findMany({
    where: { symbol: { in: universe } },
    select: { symbol: true, lastFetchedAt: true },
  });
  const lastFetchedBySymbol = new Map(snapshots.map((s) => [s.symbol, s.lastFetchedAt]));

  const stale = universe.filter((symbol) => {
    const lastFetchedAt = lastFetchedBySymbol.get(symbol) ?? null;
    return lastFetchedAt == null || lastFetchedAt < weekStart;
  });

  stale.sort((a, b) => {
    const aTime = lastFetchedBySymbol.get(a)?.getTime() ?? 0;
    const bTime = lastFetchedBySymbol.get(b)?.getTime() ?? 0;
    return aTime - bTime;
  });

  return stale.slice(0, quota);
}

interface RawEstimateRow {
  horizon?: string;
  eps_estimate_average?: string;
  eps_estimate_average_7_days_ago?: string;
  eps_estimate_average_30_days_ago?: string;
  eps_estimate_average_60_days_ago?: string;
  eps_estimate_average_90_days_ago?: string;
  eps_estimate_revision_up_trailing_7_days?: string;
  eps_estimate_revision_down_trailing_7_days?: string;
  eps_estimate_revision_up_trailing_30_days?: string;
  eps_estimate_revision_down_trailing_30_days?: string;
}

interface RawEarningsEstimatesResponse {
  symbol?: string;
  estimates?: RawEstimateRow[];
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

export interface EarningsEstimateFields {
  epsEstimateAverageCurrent: number | null;
  epsEstimateAverage7DaysAgo: number | null;
  epsEstimateAverage30DaysAgo: number | null;
  epsEstimateAverage60DaysAgo: number | null;
  epsEstimateAverage90DaysAgo: number | null;
  revisionUpTrailing7Days: number | null;
  revisionDownTrailing7Days: number | null;
  revisionUpTrailing30Days: number | null;
  revisionDownTrailing30Days: number | null;
}

export type EarningsEstimateFetchResult =
  | { status: "covered"; fields: EarningsEstimateFields }
  /** Alpha Vantage returned an empty `estimates` array — no analyst coverage at all for this symbol. */
  | { status: "no_coverage" }
  /**
   * Alpha Vantage returned a non-empty `estimates` array, but none of its
   * rows had horizon === "current quarter". Deliberately kept distinct from
   * no_coverage (a genuinely different fact — there IS analyst data, just
   * not for the horizon this app reads) so this can be watched for as a
   * pattern once live data comes in, rather than silently counted as the
   * same "nothing to show" bucket.
   */
  | { status: "no_horizon_match"; horizons: string[] }
  | { status: "error"; message: string };

const ALPHA_VANTAGE_BASE_URL = "https://www.alphavantage.co/query";

/**
 * Fetches Alpha Vantage's EARNINGS_ESTIMATES for one symbol and extracts the
 * "current quarter" horizon row — the nearest, most actionable estimate for
 * an earnings-revision signal (confirmed as the intended horizon). The
 * schema doesn't record which horizon a row came from, so switching horizons
 * later means backfilling every symbol, not just changing this function.
 */
export async function fetchEarningsEstimates(symbol: string): Promise<EarningsEstimateFetchResult> {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) {
    return { status: "error", message: "ALPHA_VANTAGE_API_KEY is not configured" };
  }

  const url = `${ALPHA_VANTAGE_BASE_URL}?function=EARNINGS_ESTIMATES&symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`;
  let body: RawEarningsEstimatesResponse;
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

  const estimates = body.estimates ?? [];
  if (estimates.length === 0) {
    return { status: "no_coverage" };
  }

  const currentQuarter = estimates.find((row) => row.horizon?.toLowerCase() === "current quarter");
  if (!currentQuarter) {
    return { status: "no_horizon_match", horizons: estimates.map((row) => row.horizon ?? "(unlabeled)") };
  }

  return {
    status: "covered",
    fields: {
      epsEstimateAverageCurrent: parseAvNumber(currentQuarter.eps_estimate_average),
      epsEstimateAverage7DaysAgo: parseAvNumber(currentQuarter.eps_estimate_average_7_days_ago),
      epsEstimateAverage30DaysAgo: parseAvNumber(currentQuarter.eps_estimate_average_30_days_ago),
      epsEstimateAverage60DaysAgo: parseAvNumber(currentQuarter.eps_estimate_average_60_days_ago),
      epsEstimateAverage90DaysAgo: parseAvNumber(currentQuarter.eps_estimate_average_90_days_ago),
      revisionUpTrailing7Days: parseAvNumber(currentQuarter.eps_estimate_revision_up_trailing_7_days),
      revisionDownTrailing7Days: parseAvNumber(currentQuarter.eps_estimate_revision_down_trailing_7_days),
      revisionUpTrailing30Days: parseAvNumber(currentQuarter.eps_estimate_revision_up_trailing_30_days),
      revisionDownTrailing30Days: parseAvNumber(currentQuarter.eps_estimate_revision_down_trailing_30_days),
    },
  };
}

export interface EarningsEstimatesRefreshResult {
  symbol: string;
  status: "covered" | "no_coverage" | "no_horizon_match" | "error";
  /** Only set when status is "no_horizon_match" — the horizon labels Alpha Vantage actually returned, for spotting whether this is a real recurring pattern. */
  horizons?: string[];
  error?: string;
}

/**
 * Fetches and persists EarningsEstimateSnapshot rows for today's batch of
 * stale symbols (see selectSymbolsToFetch). Every attempt updates
 * lastAttemptedAt; only a successful fetch (covered, confirmed no_coverage,
 * or no_horizon_match) updates lastFetchedAt, so a failed attempt doesn't
 * make a symbol look freshly refreshed and skip it for the rest of the week.
 */
export async function refreshEarningsEstimates(quota: number = DAILY_FETCH_QUOTA): Promise<EarningsEstimatesRefreshResult[]> {
  const symbols = await selectSymbolsToFetch(quota);
  const results: EarningsEstimatesRefreshResult[] = [];

  for (const symbol of symbols) {
    const result = await fetchEarningsEstimates(symbol);
    const now = new Date();

    if (result.status === "error") {
      await prisma.earningsEstimateSnapshot.upsert({
        where: { symbol },
        create: { symbol, lastAttemptedAt: now, lastErrorMessage: result.message },
        update: { lastAttemptedAt: now, lastErrorMessage: result.message },
      });
      results.push({ symbol, status: "error", error: result.message });
      continue;
    }

    if (result.status === "no_coverage") {
      await prisma.earningsEstimateSnapshot.upsert({
        where: { symbol },
        create: { symbol, hasEstimates: false, lastFetchedAt: now, lastAttemptedAt: now, lastErrorMessage: null },
        update: {
          hasEstimates: false,
          epsEstimateAverageCurrent: null,
          epsEstimateAverage7DaysAgo: null,
          epsEstimateAverage30DaysAgo: null,
          epsEstimateAverage60DaysAgo: null,
          epsEstimateAverage90DaysAgo: null,
          revisionUpTrailing7Days: null,
          revisionDownTrailing7Days: null,
          revisionUpTrailing30Days: null,
          revisionDownTrailing30Days: null,
          lastFetchedAt: now,
          lastAttemptedAt: now,
          lastErrorMessage: null,
        },
      });
      results.push({ symbol, status: "no_coverage" });
      continue;
    }

    if (result.status === "no_horizon_match") {
      await prisma.earningsEstimateSnapshot.upsert({
        where: { symbol },
        create: { symbol, hasEstimates: false, lastFetchedAt: now, lastAttemptedAt: now, lastErrorMessage: null },
        update: {
          hasEstimates: false,
          epsEstimateAverageCurrent: null,
          epsEstimateAverage7DaysAgo: null,
          epsEstimateAverage30DaysAgo: null,
          epsEstimateAverage60DaysAgo: null,
          epsEstimateAverage90DaysAgo: null,
          revisionUpTrailing7Days: null,
          revisionDownTrailing7Days: null,
          revisionUpTrailing30Days: null,
          revisionDownTrailing30Days: null,
          lastFetchedAt: now,
          lastAttemptedAt: now,
          lastErrorMessage: null,
        },
      });
      console.warn(
        `[earnings-estimates] ${symbol}: estimates array had ${result.horizons.length} row(s) but none matched "current quarter" (horizons: ${result.horizons.join(", ")})`,
      );
      results.push({ symbol, status: "no_horizon_match", horizons: result.horizons });
      continue;
    }

    await prisma.earningsEstimateSnapshot.upsert({
      where: { symbol },
      create: { symbol, hasEstimates: true, lastFetchedAt: now, lastAttemptedAt: now, lastErrorMessage: null, ...result.fields },
      update: { hasEstimates: true, lastFetchedAt: now, lastAttemptedAt: now, lastErrorMessage: null, ...result.fields },
    });
    results.push({ symbol, status: "covered" });
  }

  return results;
}
