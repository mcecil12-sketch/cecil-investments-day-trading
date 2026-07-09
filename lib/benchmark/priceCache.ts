import { prisma } from "@/lib/prisma";
import { fetchSp500History } from "@/lib/benchmark/sp500";

const STALE_AFTER_MS = 20 * 60 * 60 * 1000; // refresh at most a few times a day

function toUtcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/**
 * Refreshes the local S&P 500 price cache if it's missing or more than a
 * trading day stale. Safe to call on every request — it no-ops once fresh.
 */
export async function ensureSp500PriceCache(): Promise<void> {
  const latest = await prisma.benchmarkPrice.findFirst({ orderBy: { date: "desc" } });
  const isStale = !latest || Date.now() - latest.date.getTime() > STALE_AFTER_MS;
  if (!isStale) return;

  const points = await fetchSp500History();
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
