import { prisma } from "@/lib/prisma";
import { fetchSp500History } from "@/lib/benchmark/sp500";
import { dropUnsettledSessionBar, lastSettledSessionKey } from "@/lib/market/session";

/** Minimum gap between refresh attempts on one server instance, so holidays (no new bar ever arrives) don't refetch on every request. */
const MIN_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
let lastRefreshAttemptMs = 0;

function toUtcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Keeps the local S&P 500 cache current to the last settled session close.
 * Refreshes when the newest cached day is older than the most recent close
 * that has settled (after 4:15pm ET), and never stores today's partial bar,
 * so the cache only ever holds completed closes. Previously it refreshed on a
 * 20h clock from UTC midnight, which froze the first intraday price of the
 * day until 4pm while picks were priced live. Safe to call on every request.
 */
export async function ensureSp500PriceCache(now: Date = new Date()): Promise<void> {
  const latest = await prisma.benchmarkPrice.findFirst({ orderBy: { date: "desc" } });
  // Cached rows are stored at UTC midnight of the bar's own (NY) session date.
  const latestKey = latest ? latest.date.toISOString().slice(0, 10) : null;
  const isStale = !latestKey || latestKey < lastSettledSessionKey(now);
  if (!isStale) return;
  if (latest && now.getTime() - lastRefreshAttemptMs < MIN_REFRESH_INTERVAL_MS) return;
  lastRefreshAttemptMs = now.getTime();

  const points = dropUnsettledSessionBar(await fetchSp500History(), now);
  for (const point of points) {
    const date = toUtcMidnight(point.date);
    await prisma.benchmarkPrice.upsert({
      where: { date },
      create: { date, close: point.close },
      update: { close: point.close },
    });
  }
}

/**
 * Nearest ^GSPC close on or before the given date (i.e. the last trading
 * day at or before a weekend/holiday snapshot date).
 */
export async function getSp500CloseOnOrBefore(
  date: Date,
): Promise<{ date: Date; close: number } | null> {
  return prisma.benchmarkPrice.findFirst({
    where: { date: { lte: toUtcMidnight(date) } },
    orderBy: { date: "desc" },
  });
}

export async function getEarliestCachedSp500Date(): Promise<Date | null> {
  const earliest = await prisma.benchmarkPrice.findFirst({ orderBy: { date: "asc" } });
  return earliest?.date ?? null;
}
