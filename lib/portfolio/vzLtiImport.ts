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

const MAX_ASOF_DRIFT_DAYS = 30;

/**
 * Fidelity's Stock Plans tab is a live snapshot with no printed as-of date,
 * so Claude is asked to report today's date — a value far from "now" (e.g.
 * a misread year) is almost certainly a misread, not a real historical
 * as-of date, unlike PDF-sourced imports that carry a real printed date.
 */
export function isPlausibleVzLtiAsOfDate(date: Date, now: Date = new Date()): boolean {
  if (Number.isNaN(date.getTime())) return false;
  const driftDays = Math.abs(date.getTime() - now.getTime()) / (24 * 60 * 60 * 1000);
  return driftDays <= MAX_ASOF_DRIFT_DAYS;
}

export interface VzLtiTrancheConflict {
  cohortLabel: string;
  vestDate: string;
  shareValues: number[];
}

export interface MergedVzLtiTranches {
  tranches: ExtractedVzLtiTranche[];
  conflicts: VzLtiTrancheConflict[];
}

const SHARE_TOLERANCE = 0.01;

/**
 * Merges tranches extracted from multiple Stock Plans screenshots into one
 * list, de-duping entries that appear on more than one screenshot (the
 * tab's cohort/year views overlap). A (cohort, vest date) pair with
 * matching share counts across screenshots collapses to a single row; the
 * same pair with differing share counts is a conflict the caller must
 * surface instead of silently picking a winner.
 */
export function mergeVzLtiTranches(perScreenshot: ExtractedVzLtiTranche[][]): MergedVzLtiTranches {
  const byKey = new Map<string, ExtractedVzLtiTranche[]>();
  for (const tranches of perScreenshot) {
    for (const tranche of tranches) {
      const key = `${tranche.cohortLabel}::${tranche.vestDate}`;
      const group = byKey.get(key);
      if (group) group.push(tranche);
      else byKey.set(key, [tranche]);
    }
  }

  const tranches: ExtractedVzLtiTranche[] = [];
  const conflicts: VzLtiTrancheConflict[] = [];
  for (const group of byKey.values()) {
    const first = group[0];
    const allMatch = group.every((t) => Math.abs(t.shares - first.shares) <= SHARE_TOLERANCE);
    if (allMatch) {
      tranches.push(first);
    } else {
      conflicts.push({ cohortLabel: first.cohortLabel, vestDate: first.vestDate, shareValues: group.map((t) => t.shares) });
    }
  }

  return { tranches, conflicts };
}
