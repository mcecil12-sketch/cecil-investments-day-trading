import { prisma } from "@/lib/prisma";
import { getPriceHistory, getSp500Series, type PricePoint } from "@/lib/agents/marketData";
import { computeReturn } from "@/lib/agents/technicals";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Action verbs that are themselves all-uppercase and must never be mistaken for a ticker. */
const ACTION_VERB_STOPLIST = new Set(["ADD"]);

/**
 * Best-effort ticker extraction from an action item's text. Every action
 * string follows "VERB SYMBOL — detail" (e.g. "ADD NVDA — new candidate",
 * "Hold FSELX — leading relative strength"), except sector-level items
 * ("Reduce Technology exposure — weakening sector") where there's no single
 * symbol to track — those correctly return null, since a sector name is
 * mixed-case and won't match. Returns null rather than guessing wrong.
 */
export function extractSymbolFromAction(action: string): string | null {
  for (const rawWord of action.split(/\s+/)) {
    const word = rawWord.replace(/[—,.:;]+$/, "");
    if (ACTION_VERB_STOPLIST.has(word)) continue;
    if (/^[A-Z]{1,6}(-[A-Z]{1,2})?$/.test(word)) return word;
  }
  return null;
}

function returnSince(rawPoints: PricePoint[], fromDate: Date): number | null {
  const points = [...rawPoints].sort((a, b) => a.date.getTime() - b.date.getTime());
  if (points.length < 2) return null;
  const targetTime = fromDate.getTime();

  let start = points[0];
  for (const p of points) {
    if (p.date.getTime() <= targetTime) start = p;
    else break;
  }
  const last = points[points.length - 1];
  return computeReturn(start.close, last.close);
}

/**
 * Relative performance (symbol return minus S&P 500 return, decimal
 * fraction) from `fromDate` to now — null when fewer than `horizonDays` have
 * elapsed yet, or when price history for the symbol can't be fetched.
 */
export async function relativePerformanceSince(
  symbol: string,
  fromDate: Date,
  horizonDays: number,
): Promise<number | null> {
  const elapsedDays = (Date.now() - fromDate.getTime()) / MS_PER_DAY;
  if (elapsedDays < horizonDays) return null;

  try {
    const [{ points: symbolPoints }, sp500Points] = await Promise.all([getPriceHistory(symbol), getSp500Series()]);
    const symbolReturn = returnSince(symbolPoints, fromDate);
    const sp500Return = returnSince(sp500Points, fromDate);
    if (symbolReturn == null || sp500Return == null) return null;
    return symbolReturn - sp500Return;
  } catch {
    return null;
  }
}

/**
 * Fills in outcome30d/outcome90d for every executed RecommendationOutcome
 * that's old enough and doesn't have them yet. Called by the Performance
 * Audit page on every load — cheap no-op when nothing is eligible, since
 * most rows will already have both figures computed from a prior visit.
 */
export async function refreshRecommendationOutcomes(): Promise<void> {
  const pending = await prisma.recommendationOutcome.findMany({
    where: {
      executed: true,
      executedDate: { not: null },
      OR: [{ outcome30d: null }, { outcome90d: null }],
    },
    include: { weeklyBrief: { include: { actionItems: { orderBy: { priority: "asc" } } } } },
  });

  for (const outcome of pending) {
    if (!outcome.executedDate) continue;
    const actionItem = outcome.weeklyBrief.actionItems[outcome.actionItemIndex - 1];
    if (!actionItem) continue;
    const symbol = extractSymbolFromAction(actionItem.action);
    if (!symbol) continue;

    const updates: { outcome30d?: number; outcome90d?: number } = {};
    if (outcome.outcome30d == null) {
      const value = await relativePerformanceSince(symbol, outcome.executedDate, 30);
      if (value != null) updates.outcome30d = value;
    }
    if (outcome.outcome90d == null) {
      const value = await relativePerformanceSince(symbol, outcome.executedDate, 90);
      if (value != null) updates.outcome90d = value;
    }

    if (Object.keys(updates).length > 0) {
      await prisma.recommendationOutcome.update({ where: { id: outcome.id }, data: updates });
    }
  }
}
