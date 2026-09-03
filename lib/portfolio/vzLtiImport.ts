import { stripMarkdownFence } from "@/lib/portfolio/jsonExtract";

export interface ExtractedVzLtiTranche {
  /** Fidelity's grant cohort label, e.g. "RD24" for the 2024 grant. */
  cohortLabel: string;
  /** Always a March 1 (YYYY-MM-DD) — the date this specific third vests and pays out. */
  vestDate: string;
  /** Shares remaining unvested in this specific third, as shown on the Stock Plans tab. */
  shares: number;
}

export interface VzLtiExtractionResult {
  asOfDate: string;
  tranches: ExtractedVzLtiTranche[];
}

export const VZ_LTI_EXTRACTION_SYSTEM_PROMPT = `Extract the grant/vesting schedule from this Fidelity "Stock Plans" screenshot for a Verizon LTI (long-term incentive) account.
Return ONLY valid JSON:
{
  asOfDate: string (YYYY-MM-DD, today's date if not otherwise shown),
  tranches: [{
    cohortLabel: string (e.g. "RD24", "RD25", "RD26" — the grant cohort/year label as shown),
    vestDate: string (YYYY-MM-DD, always a March 1),
    shares: number (shares remaining unvested in this specific third)
  }]
}
Extract one entry per remaining unvested third shown — a grant with multiple remaining vest years (e.g. RD25 vesting in both 2027 and 2028) becomes multiple entries with the same cohortLabel and different vestDate/shares.
Do NOT extract or invent a dollar value per tranche — shares only. Do NOT include already-vested/paid-out thirds that aren't shown on the page.
Report shares as a plain number (e.g. 1653.52), not a formatted string.`;

/** Parses "RD24" -> 2024, "RD9" -> 2009, etc. — the grant year is always the label's trailing digits, interpreted as 2000+n. */
export function parseGrantYear(cohortLabel: string): number | null {
  const match = cohortLabel.match(/(\d{2,4})\s*$/);
  if (!match) return null;
  const digits = match[1];
  if (digits.length === 4) return Number(digits);
  return 2000 + Number(digits);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isExtractedVzLtiTranche(value: unknown): value is ExtractedVzLtiTranche {
  if (!value || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.cohortLabel === "string" &&
    t.cohortLabel.trim().length > 0 &&
    typeof t.vestDate === "string" &&
    isFiniteNumber(t.shares)
  );
}

export function parseVzLtiExtractionResponse(text: string): VzLtiExtractionResult {
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
  if (!Array.isArray(result.tranches) || result.tranches.length === 0 || !result.tranches.every(isExtractedVzLtiTranche)) {
    throw new Error("Extracted data has a malformed or empty tranches list");
  }
  for (const tranche of result.tranches as ExtractedVzLtiTranche[]) {
    if (parseGrantYear(tranche.cohortLabel) == null) {
      throw new Error(`Couldn't parse a grant year out of cohort label "${tranche.cohortLabel}"`);
    }
  }

  return {
    asOfDate: result.asOfDate,
    tranches: result.tranches as ExtractedVzLtiTranche[],
  };
}
