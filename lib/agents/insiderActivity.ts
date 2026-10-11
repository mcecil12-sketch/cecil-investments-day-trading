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
export const INSIDER_PACING_MS = MIN_REQUEST_INTERVAL_MS;

/** Hard stop on Alpha Vantage calls per monthly scan run. The monthly scan fetches all of its ranked candidates (up to 30); this is headroom, not a target. Premium key assumed as of 2026-10-06 (see docs/recommendation-tracking-groups.md). */
export const INSIDER_MAX_CALLS_PER_RUN = 60;

const WINDOW_DAYS = 30;
export const INSIDER_WINDOW_DAYS = WINDOW_DAYS;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Every field-name assumption about the Alpha Vantage response lives here.
 * Response: { data: [ { transaction_date, ticker, executive, executive_title,
 * security_type, acquisition_or_disposal, shares, share_price } ] }, all values
 * strings.
 *
 * Oct 11 2026 ROOT-CAUSE FIX: `acquisition_or_disposal` carries the SEC Form 4
 * TRANSACTION CODE (S sale, P purchase, M option exercise, F tax withholding,
 * A award, G gift, X, J, L, C ...), NOT the "A"/"D" acquired/disposed flag the
 * 2026-10-06 version of this parser assumed. Filtering on A/D matched no row,
 * so every ticker summarized to $0. Only S (sale) and P (purchase) count now;
 * everything else (exercises, withholding, awards, gifts) is excluded. This
 * also makes the figure a much tighter measure of discretionary selling than
 * the old "D = upper bound" version — S still includes 10b5-1 plan sales (no
 * planned-sale flag in the response, hence plannedFlag: null).
 */
export const INSIDER_FIELD_MAP = {
  rows: "data",
  date: "transaction_date",
  insider: "executive",
  securityType: "security_type",
  /** Holds the Form 4 transaction code (see above); name kept for compatibility. */
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
  /** Diagnostics: rows in the response, and rows inside the 30-day window (any code). */
  rowsReturned: number;
  rowsInWindow: number;
}

/** Form 4 transaction codes that count: open-market/plan sale and purchase. */
const SALE_CODE = "S";
const PURCHASE_CODE = "P";

/** Derivative / non-common instruments: their own rows are never counted. */
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
 * - Sale: non-derivative security, transaction code "S", shares > 0, price > 0.
 * - Purchase: non-derivative security, code "P", shares > 0, price > 0.
 * Everything else is excluded (M exercise, F tax withholding, A award, G gift,
 * derivative rows, price-0 rows, rows outside the window). KNOWN LIMIT: "S"
 * includes sales under 10b5-1 plans; the response has no planned-sale flag.
 * Dollar value = shares * price per row; rows missing either are skipped and
 * counted in skippedRows.
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

  let salesUsd = 0;
  let purchasesUsd = 0;
  let saleCount = 0;
  let skippedRows = 0;
  const sellers = new Set<string>();
  const plannedFlags: boolean[] = [];

  for (const row of inWindow) {
    // Derivative rows (options/RSUs/...) are never counted, whatever their code.
    if (DERIVATIVE_SECURITY.test(str(row[fields.securityType]))) continue;
    const code = str(row[fields.direction]).trim().toUpperCase();
    if (code !== SALE_CODE && code !== PURCHASE_CODE) continue;

    const shares = parseNumber(row[fields.shares]);
    const price = parseNumber(row[fields.price]);
    if (shares == null || price == null) {
      skippedRows++;
      continue;
    }
    if (shares <= 0 || price <= 0) continue;

    if (code === SALE_CODE) {
      salesUsd += shares * price;
      saleCount++;
      sellers.add(str(row[fields.insider]));
      if (fields.plannedFlag != null && row[fields.plannedFlag] != null) {
        const v = row[fields.plannedFlag];
        plannedFlags.push(v === true || v === "true" || v === "Y" || v === "1" || v === 1);
      }
    } else {
      purchasesUsd += shares * price;
    }
  }

  return {
    insiderNetSoldUsd30d: salesUsd - purchasesUsd,
    insiderSaleCount30d: saleCount,
    insiderSellers30d: sellers.size,
    insiderHas10b5_1: plannedFlags.length === 0 ? null : plannedFlags.some(Boolean),
    skippedRows,
    rowsReturned: rows.length,
    rowsInWindow: inWindow.length,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export type InsiderFetchResult =
  | { ok: true; rows: InsiderRawRow[]; responseKeys: string[] }
  | { ok: false; reason: string; responseKeys: string[] };

/**
 * One Alpha Vantage INSIDER_TRANSACTIONS call, with the failure reason and the
 * response's top-level keys for diagnostics. Alpha Vantage answers rate-limit
 * and plan problems with HTTP 200 and an "Information"/"Note"/"Error Message"
 * body, so ANY response carrying one of those keys, or lacking the expected
 * `data` array, is a FAILURE — never an ok-with-zero-rows. Never throws.
 */
export async function fetchInsiderTransactionsDetailed(symbol: string, fromDate: Date): Promise<InsiderFetchResult> {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) return { ok: false, reason: "ALPHA_VANTAGE_API_KEY is not configured", responseKeys: [] };

  const url = `${ALPHA_VANTAGE_BASE_URL}?function=INSIDER_TRANSACTIONS&symbol=${encodeURIComponent(symbol)}&from=${isoDay(fromDate)}&apikey=${apiKey}`;
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}`, responseKeys: [] };
    const body = (await response.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "response was not a JSON object", responseKeys: [] };
    const record = body as Record<string, unknown>;
    const responseKeys = Object.keys(record);
    for (const key of ["Information", "Note", "Error Message"]) {
      if (record[key]) return { ok: false, reason: `${key}: ${String(record[key]).slice(0, 120)}`, responseKeys };
    }
    const rows = record[INSIDER_FIELD_MAP.rows];
    if (!Array.isArray(rows)) return { ok: false, reason: `no "${INSIDER_FIELD_MAP.rows}" array in response`, responseKeys };
    return { ok: true, rows: rows as InsiderRawRow[], responseKeys };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message.slice(0, 120) : "network error", responseKeys: [] };
  }
}

/** Raw rows ([] when none in range), or null on any failure. Never throws. */
export async function fetchInsiderTransactions(symbol: string, fromDate: Date): Promise<InsiderRawRow[] | null> {
  const result = await fetchInsiderTransactionsDetailed(symbol, fromDate);
  return result.ok ? result.rows : null;
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
