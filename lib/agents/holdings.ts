import { prisma } from "@/lib/prisma";
import type { AccountType, ImportBatchStatus } from "@/lib/generated/prisma";

const USABLE_STATUSES: ImportBatchStatus[] = ["COMPLETE", "PARTIAL"];

export interface AccountContribution {
  accountId: string;
  accountType: AccountType;
  value: number;
}

export interface CurrentHolding {
  symbol: string;
  name: string | null;
  currentValue: number;
  accounts: AccountContribution[];
}

/**
 * Each account's latest usable snapshot, aggregated by instrument symbol
 * across accounts (a position held in two accounts nets to one entry).
 * Cash/money-market instruments are excluded — momentum and moving averages
 * aren't a meaningful signal for them. Shared by every portfolio-analysis
 * agent (Relative Strength, Sector Rotation, Risk Manager) so they all see
 * an identical view of "what do we currently hold."
 */
export async function getCurrentHoldings(): Promise<CurrentHolding[]> {
  const accounts = await prisma.account.findMany();
  const byInstrument = new Map<
    string,
    { symbol: string; name: string | null; currentValue: number; accounts: Map<string, AccountContribution> }
  >();

  for (const account of accounts) {
    const batch = await prisma.importBatch.findFirst({
      where: { accountId: account.id, status: { in: USABLE_STATUSES } },
      orderBy: [{ asOfDate: "desc" }, { uploadedAt: "desc" }],
      select: { id: true },
    });
    if (!batch) continue;

    const holdings = await prisma.holding.findMany({
      where: { importBatchId: batch.id },
      include: { instrument: true },
    });

    for (const holding of holdings) {
      if (holding.instrument.type === "CASH") continue;
      const key = holding.instrument.symbol;
      const entry = byInstrument.get(key) ?? {
        symbol: key,
        name: holding.instrument.name,
        currentValue: 0,
        accounts: new Map<string, AccountContribution>(),
      };
      entry.currentValue += holding.currentValue;
      const existing = entry.accounts.get(account.id);
      entry.accounts.set(account.id, {
        accountId: account.id,
        accountType: account.type,
        value: (existing?.value ?? 0) + holding.currentValue,
      });
      byInstrument.set(key, entry);
    }
  }

  return Array.from(byInstrument.values()).map((entry) => ({
    symbol: entry.symbol,
    name: entry.name,
    currentValue: entry.currentValue,
    accounts: Array.from(entry.accounts.values()),
  }));
}

export function totalPortfolioValue(holdings: CurrentHolding[]): number {
  return holdings.reduce((sum, h) => sum + h.currentValue, 0);
}
