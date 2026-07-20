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

export const PDF_EXTRACTION_SYSTEM_PROMPT = `You are a financial data extractor. Extract all portfolio positions from this Fidelity brokerage statement PDF. The PDF contains multiple accounts. Return ONLY valid JSON, no markdown, no explanation:
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
For cost basis shown as per-share amounts, multiply by quantity to get total cost basis. For cash/money market positions set quantity to 0 and costBasis to currentValue. Skip the Stock Plans section, Verizon LTI Plan entries, and any non-position content.`;

function isFiniteNumberOrNull(value: unknown): value is number | null {
  return value == null || (typeof value === "number" && Number.isFinite(value));
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
  if (!Array.isArray(result.accounts) || !result.accounts.every(isExtractedPdfAccount)) {
    throw new Error("Extracted data has a malformed accounts list");
  }

  return { asOfDate: result.asOfDate, accounts: result.accounts as ExtractedPdfAccount[] };
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
