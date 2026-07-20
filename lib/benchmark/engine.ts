import { prisma } from "@/lib/prisma";
import { Account } from "@/lib/generated/prisma";
import { ensureSp500PriceCache, getSp500CloseOnOrBefore } from "@/lib/benchmark/priceCache";
import { getAccountSnapshot, type AccountSnapshotValue } from "@/lib/benchmark/portfolioValue";
import { computeAlpha, computeReturn } from "@/lib/benchmark/math";

/** Rolling periods Fidelity's Performance PDF reports, in display order. "5y" and "life" are stored but not surfaced here. */
export type FidelityPeriodKey = "ytd" | "1y" | "3y";
export const FIDELITY_PERIODS: readonly FidelityPeriodKey[] = ["ytd", "1y", "3y"];

export interface AccountBenchmarkResult {
  scope: "ACCOUNT";
  accountId: string;
  accountName: string;
  accountType: string;
  isLocked: boolean;
  period: FidelityPeriodKey;
  /** As-of date of the Fidelity Performance PDF row this came from — null if no Performance PDF has reported this account/period yet. */
  asOfDate: Date | null;
  portfolioReturn: number | null;
  sp500Return: number | null;
  alpha: number | null;
  /** Current value of every holding, including locked (non-actionable) funds. */
  endValue: number;
  /** Current value that can't be reallocated (e.g. a locked company stock fund) — included in endValue but not in return/alpha. */
  currentLockedValue: number;
  /** endValue minus currentLockedValue. */
  currentActionableValue: number;
}

export interface AggregateBenchmarkResult {
  scope: "AGGREGATE_TOTAL" | "AGGREGATE_ACTIONABLE";
  period: FidelityPeriodKey;
  asOfDate: Date;
  /** Current value of every account in this scope, right now — always present. */
  currentValue: number;
  /** Value-weighted blend of each included account's Fidelity-reported return for this period. */
  portfolioReturn: number | null;
  sp500Return: number | null;
  alpha: number | null;
  accountIds: string[];
  /** Accounts in this scope with a current value but no Fidelity Performance PDF data yet for this period. */
  excludedAccountIds: string[];
}

/**
 * Cost-basis-derived return, always computed alongside the Fidelity rolling
 * periods as a permanent baseline — there's no known purchase date, so the
 * account's createdAt (when we first started tracking it) is used as the
 * best available estimate of the holding period's start, purely to give the
 * paired S&P 500 figure a comparable window. The portfolio side doesn't
 * depend on it at all.
 */
export interface AccountSincePurchaseResult {
  scope: "ACCOUNT_SINCE_PURCHASE";
  accountId: string;
  accountName: string;
  asOfDate: Date;
  costBasis: number;
  currentValue: number;
  portfolioReturn: number | null;
  estimatedHoldingStart: Date;
  sp500Return: number | null;
  alpha: number | null;
}

export interface AggregateSincePurchaseResult {
  scope: "AGGREGATE_SINCE_PURCHASE";
  asOfDate: Date;
  costBasis: number;
  currentValue: number;
  portfolioReturn: number | null;
  sp500Return: number | null;
  alpha: number | null;
}

export interface BenchmarkComputation {
  computedAt: Date;
  totalCurrentValue: number;
  accounts: AccountBenchmarkResult[];
  aggregate: AggregateBenchmarkResult[];
  sincePurchase: AccountSincePurchaseResult[];
  aggregateSincePurchase: AggregateSincePurchaseResult | null;
}

const AGGREGATE_VALUE_SELECTORS: Array<{
  scope: "AGGREGATE_TOTAL" | "AGGREGATE_ACTIONABLE";
  valueOf: (snapshot: AccountSnapshotValue) => number;
}> = [
  { scope: "AGGREGATE_TOTAL", valueOf: (s) => s.totalValue },
  { scope: "AGGREGATE_ACTIONABLE", valueOf: (s) => s.actionableValue },
];

export async function computeBenchmark(): Promise<BenchmarkComputation> {
  await ensureSp500PriceCache();

  const accounts = await prisma.account.findMany();
  const latestByAccount = new Map<string, AccountSnapshotValue>();
  for (const account of accounts) {
    const snap = await getAccountSnapshot(account.id);
    if (snap) latestByAccount.set(account.id, snap);
  }

  const accountsWithData = accounts.filter((a) => latestByAccount.has(a.id));
  const totalCurrentValue = accountsWithData.reduce(
    (sum, a) => sum + latestByAccount.get(a.id)!.totalValue,
    0,
  );

  // Latest reported AccountPerformance row per (accountId, period) — a
  // re-upload for a later as-of date should supersede the prior week's row.
  const performanceRows = await prisma.accountPerformance.findMany({
    where: { period: { in: [...FIDELITY_PERIODS] } },
    orderBy: { asOfDate: "desc" },
  });
  const latestPerformance = new Map<string, (typeof performanceRows)[number]>();
  for (const row of performanceRows) {
    const key = `${row.accountId}:${row.period}`;
    if (!latestPerformance.has(key)) latestPerformance.set(key, row);
  }

  const accountResults: AccountBenchmarkResult[] = [];
  for (const account of accountsWithData) {
    const latest = latestByAccount.get(account.id)!;
    for (const period of FIDELITY_PERIODS) {
      const perf = latestPerformance.get(`${account.id}:${period}`) ?? null;
      accountResults.push({
        scope: "ACCOUNT",
        accountId: account.id,
        accountName: account.name,
        accountType: account.type,
        isLocked: account.isLocked,
        period,
        asOfDate: perf?.asOfDate ?? null,
        portfolioReturn: perf?.returnPct ?? null,
        sp500Return: perf?.sp500ReturnPct ?? null,
        alpha: perf?.alpha ?? null,
        endValue: latest.totalValue,
        currentLockedValue: latest.lockedValue,
        currentActionableValue: latest.actionableValue,
      });
    }
  }

  const sincePurchaseResults: AccountSincePurchaseResult[] = [];
  for (const account of accountsWithData) {
    const latest = latestByAccount.get(account.id)!;
    const portfolioReturn = computeReturn(latest.costBasisTotal, latest.totalValue);

    const estimatedHoldingStart =
      account.createdAt.getTime() < latest.asOfDate.getTime() ? account.createdAt : latest.asOfDate;
    const sp500Start = await getSp500CloseOnOrBefore(estimatedHoldingStart);
    const sp500End = await getSp500CloseOnOrBefore(latest.asOfDate);
    const sp500Return = sp500Start && sp500End ? computeReturn(sp500Start.close, sp500End.close) : null;

    sincePurchaseResults.push({
      scope: "ACCOUNT_SINCE_PURCHASE",
      accountId: account.id,
      accountName: account.name,
      asOfDate: latest.asOfDate,
      costBasis: latest.costBasisTotal,
      currentValue: latest.totalValue,
      portfolioReturn,
      estimatedHoldingStart,
      sp500Return,
      alpha: computeAlpha(portfolioReturn, sp500Return),
    });
  }

  let aggregateSincePurchase: AggregateSincePurchaseResult | null = null;
  if (accountsWithData.length > 0) {
    const costBasis = accountsWithData.reduce((sum, a) => sum + latestByAccount.get(a.id)!.costBasisTotal, 0);
    const currentValue = accountsWithData.reduce((sum, a) => sum + latestByAccount.get(a.id)!.totalValue, 0);
    const portfolioReturn = computeReturn(costBasis, currentValue);

    let weightedSp500 = 0;
    let weight = 0;
    for (const result of sincePurchaseResults) {
      if (result.sp500Return == null) continue;
      weightedSp500 += result.sp500Return * result.costBasis;
      weight += result.costBasis;
    }

    aggregateSincePurchase = {
      scope: "AGGREGATE_SINCE_PURCHASE",
      asOfDate: new Date(Math.max(...accountsWithData.map((a) => latestByAccount.get(a.id)!.asOfDate.getTime()))),
      costBasis,
      currentValue,
      portfolioReturn,
      sp500Return: weight > 0 ? weightedSp500 / weight : null,
      alpha: computeAlpha(portfolioReturn, weight > 0 ? weightedSp500 / weight : null),
    };
  }

  const aggregateResults: AggregateBenchmarkResult[] = [];
  // AGGREGATE_TOTAL and AGGREGATE_ACTIONABLE run over the same set of accounts —
  // the difference is which slice of each account's value counts, and thus
  // how much weight it carries in the value-weighted blend. A locked company
  // stock fund inside an otherwise-actionable account (e.g. Verizon EDP)
  // contributes to TOTAL but drops out of ACTIONABLE via actionableValue.
  if (accountsWithData.length > 0) {
    const asOfDate = new Date(
      Math.max(...accountsWithData.map((a) => latestByAccount.get(a.id)!.asOfDate.getTime())),
    );

    for (const period of FIDELITY_PERIODS) {
      for (const { scope, valueOf } of AGGREGATE_VALUE_SELECTORS) {
        const currentValue = accountsWithData.reduce(
          (sum, a) => sum + valueOf(latestByAccount.get(a.id)!),
          0,
        );

        const included: Account[] = [];
        const excluded: Account[] = [];
        let weightedReturn = 0;
        let weightedSp500 = 0;
        let weight = 0;

        for (const account of accountsWithData) {
          const perf = latestPerformance.get(`${account.id}:${period}`);
          if (!perf) {
            excluded.push(account);
            continue;
          }
          included.push(account);
          const accountWeight = valueOf(latestByAccount.get(account.id)!);
          weightedReturn += perf.returnPct * accountWeight;
          weight += accountWeight;
          if (perf.sp500ReturnPct != null) weightedSp500 += perf.sp500ReturnPct * accountWeight;
        }

        const portfolioReturn = weight > 0 ? weightedReturn / weight : null;
        const sp500Return = weight > 0 ? weightedSp500 / weight : null;

        aggregateResults.push({
          scope,
          period,
          asOfDate,
          currentValue,
          portfolioReturn,
          sp500Return,
          alpha: computeAlpha(portfolioReturn, sp500Return),
          accountIds: included.map((a) => a.id),
          excludedAccountIds: excluded.map((a) => a.id),
        });
      }
    }
  }

  return {
    computedAt: new Date(),
    totalCurrentValue,
    accounts: accountResults,
    aggregate: aggregateResults,
    sincePurchase: sincePurchaseResults,
    aggregateSincePurchase,
  };
}
