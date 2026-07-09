import type { FidelityHoldingRow, FidelityInstrumentType } from "@/lib/portfolio/csv/fidelity";

export interface ExtractedPosition {
  symbol: string;
  name: string;
  quantity: number;
  lastPrice: number;
  currentValue: number;
  costBasis: number;
  gainLoss: number;
  gainLossPercent: number;
  percentOfAccount: number;
}

export interface ScreenshotExtractionResult {
  accountName: string;
  asOfDate: string;
  positions: ExtractedPosition[];
}

export const EXTRACTION_SYSTEM_PROMPT = `You are a financial data extractor. Extract all portfolio positions from this screenshot of a brokerage account page. Return ONLY valid JSON, no markdown, no explanation:
{
  accountName: string,
  asOfDate: string,
  positions: [{
    symbol: string,
    name: string,
    quantity: number,
    lastPrice: number,
    currentValue: number,
    costBasis: number,
    gainLoss: number,
    gainLossPercent: number,
    percentOfAccount: number
  }]
}`;

/** Claude sometimes wraps JSON in a markdown fence despite instructions not to — strip it before parsing. */
function stripMarkdownFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isExtractedPosition(value: unknown): value is ExtractedPosition {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.symbol === "string" &&
    typeof p.name === "string" &&
    isFiniteNumber(p.quantity) &&
    isFiniteNumber(p.lastPrice) &&
    isFiniteNumber(p.currentValue) &&
    isFiniteNumber(p.costBasis) &&
    isFiniteNumber(p.gainLoss) &&
    isFiniteNumber(p.gainLossPercent) &&
    isFiniteNumber(p.percentOfAccount)
  );
}

export function parseExtractionResponse(text: string): ScreenshotExtractionResult {
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
  if (typeof result.accountName !== "string" || typeof result.asOfDate !== "string") {
    throw new Error("Extracted data is missing accountName or asOfDate");
  }
  if (!Array.isArray(result.positions) || !result.positions.every(isExtractedPosition)) {
    throw new Error("Extracted data has a malformed positions list");
  }

  return {
    accountName: result.accountName,
    asOfDate: result.asOfDate,
    positions: result.positions,
  };
}

/** No "Type" column comes back from the screenshot extraction, so it's inferred from the name/symbol, same signal Fidelity's own CSV type strings key off of. */
function classifyExtractedType(position: ExtractedPosition): FidelityInstrumentType {
  const label = `${position.name} ${position.symbol}`.toUpperCase();
  if (label.includes("MONEY MARKET") || /\*\*$/.test(position.symbol.trim())) return "CASH";
  if (label.includes("FUND") || label.includes("ETF") || label.includes("INDEX")) return "FUND";
  return "STOCK";
}

export function positionsToHoldingRows(positions: ExtractedPosition[]): FidelityHoldingRow[] {
  return positions.map((position) => ({
    symbol: position.symbol,
    description: position.name,
    quantity: position.quantity,
    lastPrice: position.lastPrice,
    currentValue: position.currentValue,
    costBasisTotal: position.costBasis,
    averageCostBasis: position.quantity !== 0 ? position.costBasis / position.quantity : null,
    percentOfAccount: position.percentOfAccount,
    type: classifyExtractedType(position),
  }));
}
