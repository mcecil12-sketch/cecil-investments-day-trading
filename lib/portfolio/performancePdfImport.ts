import { stripMarkdownFence } from "@/lib/portfolio/jsonExtract";

export interface ExtractedAccountReturns {
  oneMonth: number | null;
  threeMonth: number | null;
  ytd: number | null;
  oneYear: number | null;
  threeYear: number | null;
  fiveYear: number | null;
  lifeOfData: number | null;
  lifeOfDataStartDate: string | null;
}

export interface ExtractedPerformanceAccount {
  accountName: string;
  accountNumber: string;
  returns: ExtractedAccountReturns;
}

export interface ExtractedSp500Returns {
  oneMonth: number | null;
  threeMonth: number | null;
  ytd: number | null;
  oneYear: number | null;
  threeYear: number | null;
  fiveYear: number | null;
}

export interface PerformancePdfExtractionResult {
  asOfDate: string;
  accounts: ExtractedPerformanceAccount[];
  /** The "Total" row at the bottom of the returns table — the household's blended return across every account in the PDF. Null if the PDF has no Total row. */
  totalPortfolio: ExtractedAccountReturns | null;
  benchmarks: { sp500: ExtractedSp500Returns };
}

/** Maps the extraction's named fields to the AccountPerformance.period strings, in display order. */
export const PERFORMANCE_PERIOD_KEYS = [
  { field: "oneMonth", period: "1m" },
  { field: "threeMonth", period: "3m" },
  { field: "ytd", period: "ytd" },
  { field: "oneYear", period: "1y" },
  { field: "threeYear", period: "3y" },
  { field: "fiveYear", period: "5y" },
] as const;

export const PDF_PERFORMANCE_EXTRACTION_SYSTEM_PROMPT = `Extract portfolio performance data from this Fidelity Performance PDF.
Return ONLY valid JSON:
{
  asOfDate: string (YYYY-MM-DD),
  accounts: [{
    accountName: string,
    accountNumber: string,
    returns: {
      oneMonth: number | null,
      threeMonth: number | null,
      ytd: number | null,
      oneYear: number | null,
      threeYear: number | null,
      fiveYear: number | null,
      lifeOfData: number | null,
      lifeOfDataStartDate: string | null
    }
  }],
  totalPortfolio: {
    oneMonth: number | null,
    threeMonth: number | null,
    ytd: number | null,
    oneYear: number | null,
    threeYear: number | null,
    fiveYear: number | null,
    lifeOfData: number | null,
    lifeOfDataStartDate: string | null
  } | null,
  benchmarks: {
    sp500: {
      oneMonth: number | null,
      threeMonth: number | null,
      ytd: number | null,
      oneYear: number | null,
      threeYear: number | null,
      fiveYear: number | null
    }
  }
}
Extract time-weighted pre-tax returns table. Include all accounts.
Also extract the Total row at the bottom of the returns table (the household's blended return across every account shown) as the separate top-level totalPortfolio field — not as another entry in the accounts array. Use null for any period the Total row doesn't show. Set totalPortfolio to null only if the table has no Total row at all.
Extract S&P 500 Index returns from the Market Indexes section at the bottom.
Report every return as a decimal fraction, e.g. 0.1046 for +10.46%, -0.0186 for -1.86% — not a percentage number.`;

function isFiniteNumberOrNull(value: unknown): value is number | null {
  return value == null || (typeof value === "number" && Number.isFinite(value));
}

function isExtractedAccountReturns(value: unknown): value is ExtractedAccountReturns {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    isFiniteNumberOrNull(r.oneMonth) &&
    isFiniteNumberOrNull(r.threeMonth) &&
    isFiniteNumberOrNull(r.ytd) &&
    isFiniteNumberOrNull(r.oneYear) &&
    isFiniteNumberOrNull(r.threeYear) &&
    isFiniteNumberOrNull(r.fiveYear) &&
    isFiniteNumberOrNull(r.lifeOfData) &&
    (r.lifeOfDataStartDate == null || typeof r.lifeOfDataStartDate === "string")
  );
}

function isExtractedPerformanceAccount(value: unknown): value is ExtractedPerformanceAccount {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.accountName === "string" &&
    typeof a.accountNumber === "string" &&
    isExtractedAccountReturns(a.returns)
  );
}

function isExtractedSp500Returns(value: unknown): value is ExtractedSp500Returns {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    isFiniteNumberOrNull(r.oneMonth) &&
    isFiniteNumberOrNull(r.threeMonth) &&
    isFiniteNumberOrNull(r.ytd) &&
    isFiniteNumberOrNull(r.oneYear) &&
    isFiniteNumberOrNull(r.threeYear) &&
    isFiniteNumberOrNull(r.fiveYear)
  );
}

export function parsePerformancePdfExtractionResponse(text: string): PerformancePdfExtractionResult {
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
  if (!Array.isArray(result.accounts) || !result.accounts.every(isExtractedPerformanceAccount)) {
    throw new Error("Extracted data has a malformed accounts list");
  }
  if (result.totalPortfolio != null && !isExtractedAccountReturns(result.totalPortfolio)) {
    throw new Error("Extracted data has a malformed totalPortfolio");
  }
  const benchmarks = result.benchmarks as Record<string, unknown> | undefined;
  if (!benchmarks || !isExtractedSp500Returns(benchmarks.sp500)) {
    throw new Error("Extracted data is missing benchmarks.sp500");
  }

  return {
    asOfDate: result.asOfDate,
    accounts: result.accounts as ExtractedPerformanceAccount[],
    totalPortfolio: (result.totalPortfolio as ExtractedAccountReturns | null) ?? null,
    benchmarks: { sp500: benchmarks.sp500 as ExtractedSp500Returns },
  };
}
