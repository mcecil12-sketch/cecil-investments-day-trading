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
  /** True when the menu's checkmark/"current investment mix" column marks this fund as currently held. */
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

export const PDF_FUND_MENU_EXTRACTION_SYSTEM_PROMPT = `You are a financial data extractor. Extract the COMPLETE fund menu ("Investment Choices") from this Fidelity 401k plan performance PDF. This is a reference document listing every fund the plan offers — not a positions/holdings statement. Extract every row, whether or not it's currently held. Return ONLY valid JSON, no markdown, no explanation:
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
Extract EVERY fund listed in the menu, not just the ones currently held — the whole point is having the complete menu on file for comparison. Set isHeld true only for funds marked as currently held (e.g. a checkmark, "current investment mix" indicator, or a nonzero balance shown alongside the fund). Only populate ticker when one is explicitly shown next to the fund name — leave it null for proprietary/institutional funds with no public ticker. Report every return as a decimal fraction, e.g. 0.1046 for +10.46%, -0.0186 for -1.86% — not a percentage number. If the PDF covers only one plan/account, return a single-entry accounts array.`;

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
