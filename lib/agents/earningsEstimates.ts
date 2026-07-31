import { prisma } from "@/lib/prisma";
import { getDynamicCandidateUniverse } from "@/lib/agents/candidateUniverse";
import { STATIC_CANDIDATE_UNIVERSE } from "@/lib/agents/candidateScanner";

/**
 * The full candidate universe (currently ~81 symbols): candidateScanner.ts's
 * static-sector tickers, plus whatever's cached in CandidateUniverse for the
 * SSGA-derived dynamic sectors (Energy/Healthcare/Technology — see
 * candidateUniverse.ts). Deduped since a symbol could in principle appear in
 * both a static sector list and a dynamic sector's top holdings.
 */
export async function getFullCandidateSymbols(): Promise<string[]> {
  const staticSymbols = Object.values(STATIC_CANDIDATE_UNIVERSE).flatMap((sector) => sector.symbols);
  const dynamicUniverse = await getDynamicCandidateUniverse();
  const dynamicSymbols = Object.values(dynamicUniverse).flatMap((sector) => sector.symbols);
  return Array.from(new Set([...staticSymbols, ...dynamicSymbols]));
}

/** How many symbols to fetch per cron invocation — kept comfortably under Alpha Vantage's 25/day free-tier cap, leaving 5/day headroom for retries. */
export const DAILY_FETCH_QUOTA = 20;

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
  date?: string;
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
   * Alpha Vantage returned a non-empty `estimates` array, but no
   * "fiscal quarter" row had a `date` >= today — e.g. all rows are historical
   * (no upcoming quarter yet estimated) or unexpectedly unlabeled/undated.
   * Deliberately kept distinct from no_coverage (a genuinely different fact —
   * there IS analyst data, just not a matchable current-quarter row) so this
   * can be watched for as a pattern in real data rather than silently
   * counted as the same "nothing to show" bucket.
   */
  | { status: "no_horizon_match"; horizons: string[] }
  | { status: "error"; message: string };

const ALPHA_VANTAGE_BASE_URL = "https://www.alphavantage.co/query";

/**
 * Fetches Alpha Vantage's EARNINGS_ESTIMATES for one symbol and extracts the
 * current-quarter estimate row for an earnings-revision signal.
 *
 * ROW-SELECTION RULE (engineering decision, not a documented vendor spec —
 * confirmed 2026-07-29 that Alpha Vantage's own docs for this endpoint
 * (https://www.alphavantage.co/documentation/, "Earnings Estimates
 * Trending") say only "returns the annual and quarterly EPS and revenue
 * estimates... along with analyst count and revision history" — no field
 * glossary, no `horizon` value list, no guidance on picking "the current
 * quarter"). A live test that day (BRK-B) showed the real `estimates` array
 * never contains a `horizon === "current quarter"` row; it returns one row
 * per historical/future fiscal quarter and year, labeled only "fiscal
 * quarter" (38 rows back to 2017) or "fiscal year" (2 rows), each with a
 * `date` (fiscal period end). In the absence of vendor guidance, "current
 * quarter" here is defined as: among rows with horizon === "fiscal quarter",
 * the one with the earliest `date` that is still >= today — i.e. the
 * quarter the company is currently operating in but hasn't finished/reported
 * yet, consistent with how "current quarter" estimates are conventionally
 * used elsewhere (e.g. Zacks Consensus). If this later proves wrong against
 * real revision behavior, treat it as a decision to revisit, not a bug in
 * the fetch/parse plumbing around it.
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

  // ISO "YYYY-MM-DD" strings compare lexicographically the same as chronologically.
  const todayIso = new Date().toISOString().slice(0, 10);
  const currentQuarter = estimates
    .filter((row) => row.horizon?.toLowerCase() === "fiscal quarter" && row.date != null && row.date >= todayIso)
    .sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : 0))[0];

  if (!currentQuarter) {
    const counts = new Map<string, number>();
    for (const row of estimates) {
      const label = row.horizon ?? "(unlabeled)";
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const horizons = Array.from(counts.entries()).map(([label, count]) => (count > 1 ? `${label} (x${count})` : label));
    return { status: "no_horizon_match", horizons };
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

/** Alpha Vantage's free tier rejects requests faster than 1/second; a live test on 2026-07-29 firing 12 requests back-to-back (no delay) got 11 of 12 rejected with that exact rate-limit message. 1200ms clears the 1/second limit with margin. */
const MIN_REQUEST_INTERVAL_MS = 1200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches and persists EarningsEstimateSnapshot rows for today's batch of
 * stale symbols (see selectSymbolsToFetch). Every attempt updates
 * lastAttemptedAt; only a successful fetch (covered, confirmed no_coverage,
 * or no_horizon_match) updates lastFetchedAt, so a failed attempt doesn't
 * make a symbol look freshly refreshed and skip it for the rest of the week.
 * Requests are paced at MIN_REQUEST_INTERVAL_MS apart (see above) to stay
 * under Alpha Vantage's free-tier per-second burst limit — at 20/day this
 * adds ~23s to the run, well within the cron route's 60s maxDuration.
 */
export async function refreshEarningsEstimates(quota: number = DAILY_FETCH_QUOTA): Promise<EarningsEstimatesRefreshResult[]> {
  const symbols = await selectSymbolsToFetch(quota);
  const results: EarningsEstimatesRefreshResult[] = [];

  for (let i = 0; i < symbols.length; i++) {
    if (i > 0) await sleep(MIN_REQUEST_INTERVAL_MS);
    const symbol = symbols[i];
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
        `[earnings-estimates] ${symbol}: estimates array had ${result.horizons.length} row(s) but none was a "fiscal quarter" row dated today or later (horizons: ${result.horizons.join(", ")})`,
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
