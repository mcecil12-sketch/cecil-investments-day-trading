import type { FidelityHoldingRow } from "@/lib/portfolio/csv/fidelity";
import { classifyExtractedType } from "@/lib/portfolio/screenshotImport";
import { stripMarkdownFence } from "@/lib/portfolio/jsonExtract";

export interface ExtractedPdfPosition {
  symbol: string;
  name: string;
  quantity: number | null;
  lastPrice: number | null;
  currentValue: number;
  costBasis: number | null;
  gainLoss: number | null;
  gainLossPercent: number | null;
  percentOfAccount: number | null;
}

export interface ExtractedPdfAccount {
  accountName: string;
  accountNumber: string;
  positions: ExtractedPdfPosition[];
}

export interface PdfExtractionResult {
  asOfDate: string;
  accounts: ExtractedPdfAccount[];
}

export const PDF_EXTRACTION_SYSTEM_PROMPT = `You are a financial data extractor. Extract all portfolio positions from this Fidelity brokerage statement PDF, including "My View" layouts that show more columns than the standard positions statement. The PDF contains multiple accounts. Return ONLY valid JSON, no markdown, no explanation:
{
  asOfDate: string (YYYY-MM-DD format),
  accounts: [{
    accountName: string,
    accountNumber: string,
    positions: [{
      symbol: string,
      name: string,
      quantity: number | null,
      lastPrice: number | null,
      currentValue: number,
      costBasis: number | null,
      gainLoss: number | null,
      gainLossPercent: number | null,
      percentOfAccount: number | null
    }]
  }]
}

Column layout notes:
- "My View" layouts add extra columns: Average cost basis (per-share), Cost basis total, Account type, Loaned, Hard to borrow, and CUSIP. Account type, Loaned, Hard to borrow, and CUSIP are not part of the JSON schema above — use them only as context clues (see below), never as output fields.
- Cost basis is often shown TWICE: a per-share "Average cost basis" and a "Cost basis total". Always use "Cost basis total" for the costBasis field. Never use the per-share figure, and never multiply/divide it by quantity yourself — the total column is already correct.
- The symbol field must be the actual ticker (e.g. DELL, AAPL), taken from the Symbol column, never from the name/description text. Company or fund names are sometimes truncated with an ellipsis (e.g. "DELL TECHNOLOGI...") — put that truncated text in the name field, but always resolve symbol to the real ticker shown separately, not the truncated string.
- For Verizon retirement/401k fund positions, fund names in the PDF's text layer are frequently truncated. When a name is unclear, use that row's CUSIP and/or the account section header (the heading above the holdings table) to determine which fund it is and which account it belongs to. Give your best full fund name in the name field; if truly unclear, keep the truncated text you see rather than guessing at the rest of the name.
- Every account section in the statement must produce exactly one entry in accounts, even when it has no stock positions — for example, an account holding only a small cash or money-market balance. Represent that as a single position with a cash-type symbol/name (e.g. "CASH" or the money-market fund's symbol if shown), quantity 0, and costBasis equal to currentValue. Only return positions: [] for a section if it has no holdings rows at all — never omit the account entirely.
- costBasis may legitimately be null for a retirement fund position when the statement shows no cost basis for it (common in 401k "My View" statements) — output null rather than guessing a value.
- Skip the Stock Plans section, Verizon LTI Plan entries, and any non-position content (column headers, subtotal/total rows, footnotes/disclosures).`;

function isFiniteNumberOrNull(value: unknown): value is number | null {
  return value == null || (typeof value === "number" && Number.isFinite(value));
}

/**
 * The expanded "My View" column layout gives the model more room to slip in
 * a formatted-string number (e.g. "$2.13", "(45.00)", "—" for blank cells)
 * instead of a bare number. Coerce those to numbers/null rather than
 * rejecting the whole account over a single mis-typed field.
 */
function coerceNullableNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === "-" || trimmed === "—" || trimmed === "N/A") return null;
  const negative = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed.replace(/[()$,%]/g, "");
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -Math.abs(parsed) : parsed;
}

/** Normalizes one position's numeric fields before validation; leaves symbol/name untouched. */
function normalizeExtractedPosition(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const p = value as Record<string, unknown>;
  return {
    ...p,
    quantity: coerceNullableNumber(p.quantity),
    lastPrice: coerceNullableNumber(p.lastPrice),
    currentValue: coerceNullableNumber(p.currentValue) ?? 0,
    costBasis: coerceNullableNumber(p.costBasis),
    gainLoss: coerceNullableNumber(p.gainLoss),
    gainLossPercent: coerceNullableNumber(p.gainLossPercent),
    percentOfAccount: coerceNullableNumber(p.percentOfAccount),
  };
}

/** Normalizes one account: an account with no holdings table may omit accountNumber/positions entirely. */
function normalizeExtractedAccount(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const a = value as Record<string, unknown>;
  return {
    ...a,
    accountNumber: typeof a.accountNumber === "string" ? a.accountNumber : "",
    positions: Array.isArray(a.positions) ? a.positions.map(normalizeExtractedPosition) : [],
  };
}

function isExtractedPdfPosition(value: unknown): value is ExtractedPdfPosition {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.symbol === "string" &&
    typeof p.name === "string" &&
    isFiniteNumberOrNull(p.quantity) &&
    isFiniteNumberOrNull(p.lastPrice) &&
    typeof p.currentValue === "number" &&
    Number.isFinite(p.currentValue) &&
    isFiniteNumberOrNull(p.costBasis) &&
    isFiniteNumberOrNull(p.gainLoss) &&
    isFiniteNumberOrNull(p.gainLossPercent) &&
    isFiniteNumberOrNull(p.percentOfAccount)
  );
}

function isExtractedPdfAccount(value: unknown): value is ExtractedPdfAccount {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.accountName === "string" &&
    typeof a.accountNumber === "string" &&
    Array.isArray(a.positions) &&
    a.positions.every(isExtractedPdfPosition)
  );
}

export function parsePdfExtractionResponse(text: string): PdfExtractionResult {
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
  if (!Array.isArray(result.accounts)) {
    throw new Error("Extracted data has a malformed accounts list");
  }
  // An account with zero positions (e.g. a cash-only account like "Gifts and
  // Trips") is valid — accountNumber/positions are normalized above rather
  // than required, so one sparse account doesn't fail the whole import.
  const accounts = result.accounts.map(normalizeExtractedAccount);
  if (!accounts.every(isExtractedPdfAccount)) {
    throw new Error("Extracted data has a malformed accounts list");
  }

  return { asOfDate: result.asOfDate, accounts: accounts as ExtractedPdfAccount[] };
}

/** Belt-and-suspenders filter for the "skip Stock Plans / Verizon LTI Plan" instruction — catches rows Claude includes despite the prompt. */
function isNonPositionRow(position: ExtractedPdfPosition): boolean {
  const label = `${position.name} ${position.symbol}`.toLowerCase();
  return label.includes("verizon lti") || label.includes("stock plan");
}

export function pdfPositionsToHoldingRows(positions: ExtractedPdfPosition[]): FidelityHoldingRow[] {
  return positions
    .filter((position) => !isNonPositionRow(position))
    .map((position) => {
      const quantity = position.quantity ?? 0;
      const costBasisTotal = position.costBasis;
      return {
        symbol: position.symbol,
        description: position.name,
        quantity,
        lastPrice: position.lastPrice,
        currentValue: position.currentValue,
        costBasisTotal,
        averageCostBasis: quantity !== 0 && costBasisTotal != null ? costBasisTotal / quantity : null,
        percentOfAccount: position.percentOfAccount,
        type: classifyExtractedType(position),
        ytdReturn: null,
      };
    });
}
