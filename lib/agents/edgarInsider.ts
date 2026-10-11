import { INSIDER_FIELD_MAP, type InsiderFetchResult, type InsiderRawRow } from "@/lib/agents/insiderActivity";

/**
 * SEC EDGAR as the primary insider-transaction source (logging-only, like the
 * Alpha Vantage path it replaces as first choice). Per ticker: ticker -> CIK
 * (company_tickers.json, cached a week) -> submissions JSON -> Form 4 filings
 * filed in the window -> each filing's XML -> non-derivative transactions.
 *
 * SEC fair access: a descriptive User-Agent with a real contact address (env
 * SEC_CONTACT_EMAIL — never hardcoded), <= 5 requests/second, backoff on
 * 429/403. Any non-200 or unparseable body is a FAILURE, never zero rows.
 */

export const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const SUBMISSIONS_URL = (cik10: string) => `https://data.sec.gov/submissions/CIK${cik10}.json`;
const FILING_URL = (cikNum: string, accessionNoDashes: string, file: string) => `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accessionNoDashes}/${file}`;

/** 220ms between requests = 4.5/s, under SEC's 10/s limit and our 5/s cap. */
export const EDGAR_MIN_INTERVAL_MS = 220;
const TICKER_MAP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FILINGS_PER_TICKER = 100;
const BACKOFF_MS = [2_000, 6_000];

export class EdgarError extends Error {}

export interface EdgarStats {
  requests: number;
  backoffs: number;
}

export interface EdgarClientOptions {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Defaults to process.env.SEC_CONTACT_EMAIL. */
  contactEmail?: string | null;
  minIntervalMs?: number;
}

export function edgarUserAgent(contactEmail: string): string {
  return `CecilInvestments insider-research (${contactEmail})`;
}

export function createEdgarClient(options: EdgarClientOptions = {}) {
  const fetchFn = options.fetchFn ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const minInterval = options.minIntervalMs ?? EDGAR_MIN_INTERVAL_MS;
  const stats: EdgarStats = { requests: 0, backoffs: 0 };
  let lastRequestAt = -Infinity;
  let tickerMap: { at: number; map: Map<string, string> } | null = null;

  const contact = () => (options.contactEmail === undefined ? process.env.SEC_CONTACT_EMAIL : options.contactEmail) ?? null;

  /** One paced GET. Backs off on 429/403 (SEC's throttle signals), throws EdgarError on any non-200. */
  async function getText(url: string): Promise<string> {
    const email = contact();
    if (!email) throw new EdgarError("SEC_CONTACT_EMAIL is not set (SEC requires a contact in the User-Agent)");
    for (let attempt = 0; ; attempt++) {
      const wait = lastRequestAt + minInterval - now();
      if (wait > 0) await sleep(wait);
      lastRequestAt = now();
      stats.requests++;
      const res = await fetchFn(url, { headers: { "User-Agent": edgarUserAgent(email), Accept: "*/*" }, cache: "no-store" });
      if (res.status === 429 || res.status === 403) {
        if (attempt >= BACKOFF_MS.length) throw new EdgarError(`SEC throttled the request (HTTP ${res.status}) after ${attempt} backoffs`);
        stats.backoffs++;
        await sleep(BACKOFF_MS[attempt]);
        lastRequestAt = now();
        continue;
      }
      if (res.status !== 200) throw new EdgarError(`SEC returned HTTP ${res.status} for ${url.replace(/^https:\/\//, "").slice(0, 60)}`);
      return await res.text();
    }
  }

  async function cikFor(ticker: string): Promise<string | null> {
    if (!tickerMap || now() - tickerMap.at > TICKER_MAP_TTL_MS) {
      const body = await getText(SEC_TICKERS_URL);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new EdgarError("company_tickers.json was not valid JSON");
      }
      const map = parseTickerMap(parsed);
      if (map.size === 0) throw new EdgarError("company_tickers.json had no usable entries");
      tickerMap = { at: now(), map };
    }
    return tickerMap.map.get(ticker.toUpperCase()) ?? null;
  }

  return { getText, cikFor, stats, hasContact: () => contact() != null };
}
export type EdgarClient = ReturnType<typeof createEdgarClient>;

/** company_tickers.json -> UPPER ticker -> 10-digit zero-padded CIK. */
export function parseTickerMap(json: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!json || typeof json !== "object") return map;
  for (const entry of Object.values(json as Record<string, unknown>)) {
    const e = entry as { cik_str?: unknown; ticker?: unknown };
    if ((typeof e?.cik_str === "number" || typeof e?.cik_str === "string") && typeof e.ticker === "string") {
      map.set(e.ticker.toUpperCase(), String(e.cik_str).padStart(10, "0"));
    }
  }
  return map;
}

// ---- Form 4 XML parsing (machine-generated, regular structure) ----

function blocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[1]);
  return out;
}

/** `<tag><value>x</value></tag>` or `<tag>x</tag>`; null when absent/empty. */
function valueOf(block: string, tag: string): string | null {
  const wrapped = new RegExp(`<${tag}>\\s*<value>([^<]*)</value>`).exec(block);
  if (wrapped) return wrapped[1].trim() || null;
  const plain = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(block);
  return plain ? plain[1].trim() || null : null;
}

const COMMON_TITLE = /common|ordinary|class\s+[a-z]\b|\bstock\b|\bshares?\b/i;
const NOT_COMMON_TITLE = /\bpreferred\b|\bnotes?\b|\bbonds?\b|\bdebentures?\b|\bwarrants?\b|\boptions?\b|\bunits?\b|\brights?\b/i;

export interface ParsedForm4 {
  rows: InsiderRawRow[];
  /** Non-derivative rows seen, including ones dropped as non-common. */
  nonDerivativeRows: number;
}

/** Throws EdgarError when the document is not a Form 4 ownershipDocument. */
export function parseForm4Xml(xml: string, ticker: string): ParsedForm4 {
  if (!/<ownershipDocument[\s>]/.test(xml)) throw new EdgarError("response was not a Form 4 ownershipDocument");

  const owner = blocks(xml, "reportingOwner")[0] ?? "";
  const ownerName = valueOf(owner, "rptOwnerName") ?? "";
  const officerTitle = valueOf(owner, "officerTitle");
  const title = officerTitle ?? (valueOf(owner, "isDirector") === "1" || valueOf(owner, "isDirector") === "true" ? "Director" : valueOf(owner, "otherText") ?? "");

  // Rule 10b5-1 checkbox (added to Form 4 in 2023): present => true/false for the whole filing; absent (older forms) => unknown.
  const flagRaw = valueOf(xml, "aff10b5One");
  const planned = flagRaw == null ? undefined : flagRaw === "1" || flagRaw.toLowerCase() === "true";

  const rows: InsiderRawRow[] = [];
  let nonDerivativeRows = 0;
  for (const tx of blocks(xml, "nonDerivativeTransaction")) {
    nonDerivativeRows++;
    const securityTitle = valueOf(tx, "securityTitle") ?? "";
    if (NOT_COMMON_TITLE.test(securityTitle) || !COMMON_TITLE.test(securityTitle)) continue;
    const code = valueOf(tx, "transactionCode");
    const acquiredDisposed = valueOf(tx, "transactionAcquiredDisposedCode");
    // A sale must be a disposal and a purchase an acquisition; anything else is malformed — drop rather than guess.
    if ((code === "S" && acquiredDisposed !== "D") || (code === "P" && acquiredDisposed !== "A")) continue;
    rows.push({
      transaction_date: valueOf(tx, "transactionDate") ?? "",
      ticker,
      executive: ownerName,
      executive_title: title,
      security_type: securityTitle,
      acquisition_or_disposal: code ?? "",
      acquired_disposed: acquiredDisposed ?? "",
      shares: valueOf(tx, "transactionShares") ?? "",
      share_price: valueOf(tx, "transactionPricePerShare") ?? "",
      ...(planned === undefined ? {} : { is_10b5_1: planned }),
    });
  }
  return { rows, nonDerivativeRows };
}

export const EDGAR_FIELD_MAP = { ...INSIDER_FIELD_MAP, plannedFlag: "is_10b5_1" as string | null };

interface RecentFilings {
  form?: unknown;
  filingDate?: unknown;
  accessionNumber?: unknown;
  primaryDocument?: unknown;
}

/** The raw XML lives beside the XSL-rendered primaryDocument ("xslF345X05/doc.xml" -> "doc.xml"). */
export function rawXmlName(primaryDocument: string): string {
  return primaryDocument.split("/").pop() ?? primaryDocument;
}

/** Form 4s filed on/after `from`, newest first, from a submissions JSON. Throws EdgarError if the shape is wrong. */
export function selectForm4Filings(submissions: unknown, from: Date): Array<{ accession: string; file: string; filingDate: string }> {
  const recent = (submissions as { filings?: { recent?: RecentFilings } } | null)?.filings?.recent;
  if (!recent || !Array.isArray(recent.form) || !Array.isArray(recent.filingDate) || !Array.isArray(recent.accessionNumber) || !Array.isArray(recent.primaryDocument)) {
    throw new EdgarError("submissions JSON had no filings.recent arrays");
  }
  const fromDay = from.toISOString().slice(0, 10);
  const out: Array<{ accession: string; file: string; filingDate: string }> = [];
  for (let i = 0; i < recent.form.length; i++) {
    if (recent.form[i] !== "4") continue;
    const filingDate = String(recent.filingDate[i]);
    if (filingDate < fromDay) continue;
    out.push({ accession: String(recent.accessionNumber[i]), file: rawXmlName(String(recent.primaryDocument[i])), filingDate });
  }
  return out.sort((a, b) => b.filingDate.localeCompare(a.filingDate));
}

/**
 * Insider transactions for one ticker from EDGAR, as InsiderRawRow[] shaped
 * for summarizeInsiderActivity (S/P codes, non-derivative common only, plus an
 * is_10b5_1 flag when the filing carries one). Never throws: any failure is
 * { ok: false }. `deadlineAtMs` aborts cleanly mid-ticker (aborted: true).
 */
export async function fetchEdgarInsider(
  client: EdgarClient,
  symbol: string,
  from: Date,
  opts: { deadlineAtMs?: number; now?: () => number } = {},
): Promise<InsiderFetchResult> {
  const now = opts.now ?? Date.now;
  const startRequests = client.stats.requests;
  const used = () => ({ requests: client.stats.requests - startRequests });
  try {
    if (!client.hasContact()) return { ok: false, reason: "SEC_CONTACT_EMAIL is not set", responseKeys: [], source: "edgar" };
    const cik10 = await client.cikFor(symbol);
    if (!cik10) return { ok: false, reason: `ticker ${symbol} not in SEC company_tickers.json`, responseKeys: [], source: "edgar", meta: used() };

    let submissions: unknown;
    try {
      submissions = JSON.parse(await client.getText(SUBMISSIONS_URL(cik10)));
    } catch (err) {
      if (err instanceof EdgarError) throw err;
      throw new EdgarError("submissions response was not valid JSON");
    }
    const all = selectForm4Filings(submissions, from);
    const filings = all.slice(0, MAX_FILINGS_PER_TICKER);
    const cikNum = String(Number(cik10));

    const rows: InsiderRawRow[] = [];
    for (const f of filings) {
      if (opts.deadlineAtMs != null && now() > opts.deadlineAtMs) {
        return { ok: false, reason: "time budget reached mid-ticker", responseKeys: [], source: "edgar", aborted: true, meta: used() };
      }
      const xml = await client.getText(FILING_URL(cikNum, f.accession.replace(/-/g, ""), f.file));
      rows.push(...parseForm4Xml(xml, symbol).rows);
    }
    return {
      ok: true,
      rows,
      responseKeys: ["submissions", `form4:${filings.length}`],
      source: "edgar",
      fields: EDGAR_FIELD_MAP,
      meta: { ...used(), filings: filings.length, truncatedFilings: all.length > filings.length },
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message.slice(0, 160) : "EDGAR error", responseKeys: [], source: "edgar", meta: used() };
  }
}

/** Process-wide client (shares the weekly ticker->CIK cache and rate limiter across calls in one instance). */
export const defaultEdgarClient: EdgarClient = createEdgarClient();
