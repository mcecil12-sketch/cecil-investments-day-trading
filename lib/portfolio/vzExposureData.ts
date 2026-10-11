import { prisma } from "@/lib/prisma";
import type { ImportBatchStatus } from "@/lib/generated/prisma";
import { getPriceHistory } from "@/lib/agents/marketData";
import {
  computeVzExposure,
  computeVzPriceStats,
  type VzExposure,
  type VzExposureAccount,
  type VzPriceStats,
} from "@/lib/portfolio/vzExposure";

const USABLE_STATUSES: ImportBatchStatus[] = ["COMPLETE", "PARTIAL"];

export async function loadVzExposureAccounts(): Promise<VzExposureAccount[]> {
  const accounts = await prisma.account.findMany({ orderBy: { createdAt: "asc" } });
  const result: VzExposureAccount[] = [];
  for (const account of accounts) {
    if (account.type === "VZ_LTI") {
      const batch = await prisma.importBatch.findFirst({
        where: { accountId: account.id, status: { in: USABLE_STATUSES }, vzLtiTranches: { some: {} } },
        orderBy: [{ asOfDate: "desc" }, { uploadedAt: "desc" }],
        select: { id: true },
      });
      const tranches = batch ? await prisma.vzLtiTranche.findMany({ where: { importBatchId: batch.id } }) : [];
      result.push({
        name: account.name,
        type: account.type,
        holdings: [],
        ltiShares: tranches.reduce((sum, t) => sum + t.shares, 0),
        ltiFrozenValue: tranches.reduce((sum, t) => sum + t.currentValue, 0),
      });
      continue;
    }
    const batch = await prisma.importBatch.findFirst({
      where: { accountId: account.id, status: { in: USABLE_STATUSES }, holdings: { some: {} } },
      orderBy: [{ asOfDate: "desc" }, { uploadedAt: "desc" }],
      select: { id: true },
    });
    const holdings = batch
      ? await prisma.holding.findMany({ where: { importBatchId: batch.id }, include: { instrument: true } })
      : [];
    result.push({
      name: account.name,
      type: account.type,
      holdings: holdings.map((h) => ({
        symbol: h.instrument.symbol,
        name: h.instrument.name,
        currentValue: h.currentValue,
        lastPrice: h.lastPrice,
      })),
    });
  }
  return result;
}

export async function loadVzPriceStats(): Promise<VzPriceStats | null> {
  try {
    const history = await getPriceHistory("VZ");
    return computeVzPriceStats(history.points);
  } catch (err) {
    console.error("VZ price stats unavailable:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Display-only Verizon-linked exposure; throws only if the database read fails. */
export async function getVzExposure(totalPortfolioValue: number | null): Promise<VzExposure> {
  const [accounts, price] = await Promise.all([loadVzExposureAccounts(), loadVzPriceStats()]);
  return computeVzExposure({ accounts, price, totalPortfolioValue });
}
