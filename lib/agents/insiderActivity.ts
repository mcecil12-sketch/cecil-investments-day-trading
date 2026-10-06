/**
 * Logging-only insider-activity signals for the monthly scan's top-ranked
 * candidates, from Alpha Vantage INSIDER_TRANSACTIONS. NOT part of the
 * composite score, ranking, or banding (see the dated note in
 * scoringShared.ts) — logged so the Performance Analyst can test whether
 * heavy insider selling predicts underperformance.
 */

const ALPHA_VANTAGE_BASE_URL = "https://www.alphavantage.co/query";

/** Same pacing constant/rationale as newsSentimentScore.ts / earningsHistory.ts. */
const MIN_REQUEST_INTERVAL_MS = 1200;

/** Hard stop on Alpha Vantage calls per monthly scan run. The monthly scan fetches all of its ranked candidates (up to 30); this is headroom, not a target. Premium key assumed as of 2026-10-06 (see docs/recommendation-tracking-groups.md). */
export const INSIDER_MAX_CALLS_PER_RUN = 60;

const WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Every field-name assumption about the Alpha Vantage response lives here.
 * Verified 2026-10-06 against a real STX response: { data: [ { transaction_date,
 * ticker, executive, executive_title, security_type, acquisition_or_disposal
 * ("A"|"D"), shares, share_price } ] }, all values strings. The response has
 * NO transaction code (open-market sale vs. tax withholding vs. gift vs.
 * exercise) and NO 10b5-1 indicator, hence plannedFlag: null (always null).
 */
export const INSIDER_FIELD_MAP = {
  rows: "data",
  date: "transaction_date",
  insider: "executive",
  securityType: "security_type",
  direction: "acquisition_or_disposal",
  shares: "shares",
  price: "share_price",
  plannedFlag: null as string | null,
};
export type InsiderFieldMap = typeof INSIDER_FIELD_MAP;

export type InsiderRawRow = Record<string, unknown>;

export interface InsiderSummary {
  /** Sale dollars minus purchase dollars over the trailing 30 days; positive = net selling. */
  insiderNetSoldUsd30d: number;
  insiderSaleCount30d: number;
  insiderSellers30d: number;
  /** True/false only if the data carries a planned-sale flag (never, with the real API today); otherwise null. */
  insiderHas10b5_1: boolean | null;
  /** Debug only — logged, not stored: in-window ordinary-share rows skipped for a missing/unparseable shares or price. */
  skippedRows: number;
}

/** Derivative / non-common instruments: their own rows are never counted, and a same-day same-insider one marks an option exercise. */
const DERIVATIVE_SECURITY = /option|unit|warrant|right|derivative|convertible|restricted|performance|swap|forward/i;

function parseNumber(value: unknown): number | null {
  if (value == null || value === "" || value === "None" || value === "-") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Summarizes the trailing 30 days (asOf - 30d, asOf] using ONLY these rows:
 * - Sale: non-derivative security (e.g. "Ordinary Shares"), direction "D",
 *   shares > 0 and price > 0.
 * - Purchase: non-derivative security, direction "A", shares > 0 and price > 0,
 *   and the same insider has NO derivative-security row (option/RSU/PSU...)
 *   that same day — an "A" at a positive price alongside a derivative row is
 *   an option exercise acquired at its strike price, not an open-market buy.
 * Excluded: every derivative-security row; any row with price 0 (awards, RSU
 * vests, gifts); rows outside the window.
 * KNOWN LIMIT: the API has no transaction code, so "D" rows at a positive
 * price include tax withholding and exercise-and-sell lots as well as true
 * open-market sales — insiderNetSoldUsd30d is an upper bound on discretionary
 * selling. Dollar value = shares * price per row; rows missing either are
 * skipped and counted in skippedRows.
 */
export function summarizeInsiderActivity(
  rows: InsiderRawRow[],
  asOf: Date,
  fields: InsiderFieldMap = INSIDER_FIELD_MAP,
): InsiderSummary {
  const windowStart = asOf.getTime() - WINDOW_DAYS * DAY_MS;
  const inWindow = rows.filter((row) => {
    const t = Date.parse(str(row[fields.date]));
    return Number.isFinite(t) && t > windowStart && t <= asOf.getTime();
  });

  const derivativeDays = new Set(
    inWindow
      .filter((r) => DERIVATIVE_SECURITY.test(str(r[fields.securityType])))
      .map((r) => `${str(r[fields.insider])}@@${str(r[fields.date])}`),
  );

  let salesUsd = 0;
  let purchasesUsd = 0;
  let saleCount = 0;
  let skippedRows = 0;
  const sellers = new Set<string>();
  const plannedFlags: boolean[] = [];

  for (const row of inWindow) {
    const securityType = str(row[fields.securityType]);
    if (DERIVATIVE_SECURITY.test(securityType)) continue;
    const direction = str(row[fields.direction]).toUpperCase();
    if (direction !== "A" && direction !== "D") continue;

    const shares = parseNumber(row[fields.shares]);
    const price = parseNumber(row[fields.price]);
    if (shares == null || price == null) {
      skippedRows++;
      continue;
    }
    if (shares <= 0 || price <= 0) continue;

    const insider = str(row[fields.insider]);
    if (direction === "D") {
      salesUsd += shares * price;
      saleCount++;
      sellers.add(insider);
      if (fields.plannedFlag != null && row[fields.plannedFlag] != null) {
        const v = row[fields.plannedFlag];
        plannedFlags.push(v === true || v === "true" || v === "Y" || v === "1" || v === 1);
      }
    } else if (!derivativeDays.has(`${insider}@@${str(row[fields.date])}`)) {
      purchasesUsd += shares * price;
    }
  }

  return {
    insiderNetSoldUsd30d: salesUsd - purchasesUsd,
    insiderSaleCount30d: saleCount,
    insiderSellers30d: sellers.size,
    insiderHas10b5_1: plannedFlags.length === 0 ? null : plannedFlags.some(Boolean),
    skippedRows,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * One Alpha Vantage INSIDER_TRANSACTIONS call. Returns the raw rows ([] when
 * the symbol has none in range), or null on any failure — missing key, HTTP
 * error, rate-limit/premium message, or an unrecognized body. Never throws.
 */
export async function fetchInsiderTransactions(symbol: string, fromDate: Date): Promise<InsiderRawRow[] | null> {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) return null;

  const url = `${ALPHA_VANTAGE_BASE_URL}?function=INSIDER_TRANSACTIONS&symbol=${encodeURIComponent(symbol)}&from=${isoDay(fromDate)}&apikey=${apiKey}`;
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    if (body.Note || body.Information || body["Error Message"]) return null;
    const rows = body[INSIDER_FIELD_MAP.rows];
    return Array.isArray(rows) ? (rows as InsiderRawRow[]) : null;
  } catch {
    return null;
  }
}

/**
 * Fetches and summarizes insider activity for `symbols` sequentially at
 * Alpha Vantage's pacing, stopping at INSIDER_MAX_CALLS_PER_RUN. A symbol
 * that fails (or is past the budget) maps to null. Never throws.
 */
export async function getInsiderActivity(
  symbols: string[],
  asOf: Date,
): Promise<{ summaries: Map<string, InsiderSummary | null>; callsUsed: number }> {
  const summaries = new Map<string, InsiderSummary | null>();
  let callsUsed = 0;
  const fromDate = new Date(asOf.getTime() - WINDOW_DAYS * DAY_MS);

  for (const symbol of symbols) {
    if (callsUsed >= INSIDER_MAX_CALLS_PER_RUN) {
      summaries.set(symbol, null);
      continue;
    }
    if (callsUsed > 0) await sleep(MIN_REQUEST_INTERVAL_MS);
    callsUsed++;
    const rows = await fetchInsiderTransactions(symbol, fromDate);
    if (rows == null) {
      summaries.set(symbol, null);
      continue;
    }
    try {
      const summary = summarizeInsiderActivity(rows, asOf);
      if (summary.skippedRows > 0) console.log(`[insider] ${symbol}: skipped ${summary.skippedRows} row(s) missing shares/price`);
      summaries.set(symbol, summary);
    } catch {
      summaries.set(symbol, null);
    }
  }

  console.log(`[insider] Alpha Vantage calls used this run: ${callsUsed}/${INSIDER_MAX_CALLS_PER_RUN}`);
  return { summaries, callsUsed };
}
