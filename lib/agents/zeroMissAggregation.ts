import { prisma } from "@/lib/prisma";

export interface ZeroMissMonthResult {
  /** "YYYY-MM" */
  monthKey: string;
  /** How many distinct weekly Candidate Scanner batches (batchTag) were logged this month — the denominator "zero misses" is checked against. */
  snapshotCount: number;
  /** True when monthKey is the current, still-in-progress calendar month — the qualifying list below isn't a final confirmed result yet, just what's held up so far. */
  isCurrentMonth: boolean;
  /** Symbols present in every one of this month's weekly batches. */
  qualifyingSymbols: Array<{ symbol: string; appearances: number }>;
}

function monthKeyOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthBounds(monthKey: string): { start: Date; end: Date } {
  const [year, month] = monthKey.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  return { start, end };
}

/**
 * Group 2 — zero-miss weekly persistence aggregation. A read-only report,
 * not a scoring agent: queries every GROUP_1 (weekly Candidate Scanner)
 * CandidateRecommendationLog row logged within the given calendar month,
 * groups them by batchTag (one batch per weekly scan), and surfaces only the
 * symbols that appeared in every single batch that month — zero misses.
 * `snapshotCount` is reported alongside the qualifying list so a
 * still-in-progress month (fewer batches logged so far) is never mistaken
 * for a final confirmed result; see isCurrentMonth.
 *
 * Never used for live trading decisions — research/tracking only.
 */
export async function computeZeroMissMonth(monthKey: string): Promise<ZeroMissMonthResult> {
  const { start, end } = monthBounds(monthKey);
  const rows = await prisma.candidateRecommendationLog.findMany({
    where: { group: "GROUP_1", recommendedAt: { gte: start, lt: end } },
    select: { symbol: true, batchTag: true },
  });

  const batchTags = new Set(rows.map((r) => r.batchTag));
  const snapshotCount = batchTags.size;

  const appearancesBySymbol = new Map<string, Set<string>>();
  for (const row of rows) {
    let batches = appearancesBySymbol.get(row.symbol);
    if (!batches) {
      batches = new Set();
      appearancesBySymbol.set(row.symbol, batches);
    }
    batches.add(row.batchTag);
  }

  const qualifyingSymbols = [...appearancesBySymbol.entries()]
    .filter(([, batches]) => snapshotCount > 0 && batches.size === snapshotCount)
    .map(([symbol, batches]) => ({ symbol, appearances: batches.size }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  const isCurrentMonth = monthKey === monthKeyOf(new Date());

  return { monthKey, snapshotCount, isCurrentMonth, qualifyingSymbols };
}

/** Every calendar month (most recent first) that has at least one GROUP_1 batch logged, for populating the Group 2 report across all of history rather than just the current month. */
export async function listZeroMissMonths(): Promise<ZeroMissMonthResult[]> {
  const rows = await prisma.candidateRecommendationLog.findMany({
    where: { group: "GROUP_1" },
    select: { recommendedAt: true },
    orderBy: { recommendedAt: "asc" },
  });

  const monthKeys = [...new Set(rows.map((r) => monthKeyOf(r.recommendedAt)))].sort().reverse();
  return Promise.all(monthKeys.map((monthKey) => computeZeroMissMonth(monthKey)));
}
