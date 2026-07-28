import { stripMarkdownFence } from "@/lib/portfolio/jsonExtract";

export interface ExtractedFundMenuEntry {
  fundName: string;
  assetClass: string | null;
  /** Public ticker, only present when the plan's fund menu actually shows one — most proprietary institutional 401k funds don't have one. */
  ticker: string | null;
  oneYear: number | null;
  threeYear: number | null;
  fiveYear: number | null;
  tenYear: number | null;
  /** YYYY-MM-DD, null if the menu doesn't show an inception date for this fund. */
  inceptionDate: string | null;
  /** True only when the menu's dedicated checkmark column (a brownish-orange checkmark, per Fidelity's fund menu layout) marks this fund as currently held — see the extraction prompt's HELD DETECTION section for what NOT to infer this from. */
  isHeld: boolean;
}

export interface ExtractedFundMenuAccount {
  accountName: string;
  accountNumber: string;
  funds: ExtractedFundMenuEntry[];
}

export interface FundMenuPdfExtractionResult {
  asOfDate: string;
  accounts: ExtractedFundMenuAccount[];
}

export const PDF_FUND_MENU_EXTRACTION_SYSTEM_PROMPT = `You are a financial data extractor. Extract the COMPLETE fund menu ("Investment Choices") from this Fidelity 401k plan performance page. The source may be a full PDF export, or one or more screenshots of the same page — see the multi-image note below. This is a reference document listing every fund the plan offers — not a positions/holdings statement. Extract every row visible, whether or not it's currently held. If this looks like it only captures part of a longer scrollable table (e.g. it's cut off, or the fund count looks small for a typical plan menu), extract what's visible anyway — the caller reviews the extracted count against the expected menu size before importing. Return ONLY valid JSON, no markdown, no explanation:
{
  asOfDate: string (YYYY-MM-DD format),
  accounts: [{
    accountName: string,
    accountNumber: string,
    funds: [{
      fundName: string,
      assetClass: string | null,
      ticker: string | null,
      oneYear: number | null,
      threeYear: number | null,
      fiveYear: number | null,
      tenYear: number | null,
      inceptionDate: string | null (YYYY-MM-DD, null if not shown),
      isHeld: boolean
    }]
  }]
}
Extract EVERY fund listed in the menu, not just the ones currently held — the whole point is having the complete menu on file for comparison.

HELD DETECTION — this is the part most likely to go wrong, so follow it exactly. The ONLY reliable held-indicator is a brownish-orange checkmark in its own dedicated column. isHeld defaults to false; set it true ONLY when that specific checkmark is present on that fund's row. Do NOT use any of the following as a held-signal, no matter how it looks: a "Plan-specific option" column (this describes the fund's type/eligibility and typically reads "Yes" for every single fund in the menu — it has nothing to do with what's held), any other Yes/No or descriptive column, a return figure, a percentage, or any other number in the row. If you cannot find the dedicated checkmark column at all, set isHeld false for every fund rather than guessing from anything else.

MULTIPLE IMAGES — when more than one image is provided in this request, treat them as sequential parts of ONE continuous table (e.g. successive screenshots scrolling down the same page), not as independent documents. Column headers (Fund, Asset Class, Plan-specific option, 1Y/3Y/5Y/10Y, the checkmark column, etc.) and the account name/number are typically only visible in the first image — carry that column structure and account identity forward and apply it to the unlabeled rows in later images by position/left-to-right alignment, not by re-detecting headers in each image. Combine all images' rows into one funds list for that account. If consecutive images overlap (the same fund appears at the bottom of one image and the top of the next from scroll overlap), include it only once.

Only populate ticker when one is explicitly shown next to the fund name — leave it null for proprietary/institutional funds with no public ticker. Report every return as a decimal fraction, e.g. 0.1046 for +10.46%, -0.0186 for -1.86% — not a percentage number. If the source covers only one plan/account, return a single-entry accounts array.`;

function isFiniteNumberOrNull(value: unknown): value is number | null {
  return value == null || (typeof value === "number" && Number.isFinite(value));
}

function isNonEmptyStringOrNull(value: unknown): value is string | null {
  return value == null || typeof value === "string";
}

function isExtractedFundMenuEntry(value: unknown): value is ExtractedFundMenuEntry {
  if (!value || typeof value !== "object") return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.fundName === "string" &&
    isNonEmptyStringOrNull(f.assetClass) &&
    isNonEmptyStringOrNull(f.ticker) &&
    isFiniteNumberOrNull(f.oneYear) &&
    isFiniteNumberOrNull(f.threeYear) &&
    isFiniteNumberOrNull(f.fiveYear) &&
    isFiniteNumberOrNull(f.tenYear) &&
    isNonEmptyStringOrNull(f.inceptionDate) &&
    typeof f.isHeld === "boolean"
  );
}

function isExtractedFundMenuAccount(value: unknown): value is ExtractedFundMenuAccount {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.accountName === "string" &&
    typeof a.accountNumber === "string" &&
    Array.isArray(a.funds) &&
    a.funds.length > 0 &&
    a.funds.every(isExtractedFundMenuEntry)
  );
}

export function parseFundMenuPdfExtractionResponse(text: string): FundMenuPdfExtractionResult {
  let data: unknown;
  try {
    data = JSON.parse(stripMarkdownFence(text));
  } catch {
    throw new Error("Claude's response wasn't valid JSON");
  }

  if (!data || typeof data !== "object") {
    throw new Error("Extracted data wasn't a JSON object");
  }
  const result = data as Record<string, unknown>;
  if (typeof result.asOfDate !== "string") {
    throw new Error("Extracted data is missing asOfDate");
  }
  if (!Array.isArray(result.accounts) || result.accounts.length === 0 || !result.accounts.every(isExtractedFundMenuAccount)) {
    throw new Error("Extracted data has a malformed accounts list");
  }

  return { asOfDate: result.asOfDate, accounts: result.accounts as ExtractedFundMenuAccount[] };
}
