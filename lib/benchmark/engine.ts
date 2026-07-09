import { prisma } from "@/lib/prisma";
import { Account, BenchmarkScope } from "@/lib/generated/prisma";
import { ensureSp500PriceCache, getSp500CloseOnOrBefore } from "@/lib/benchmark/priceCache";
import {
  getAccountSnapshot,
  getEarliestAccountSnapshot,
  type AccountSnapshotValue,
} from "@/lib/benchmark/portfolioValue";
import {
  BENCHMARK_PERIODS,
  computeAlpha,
  computeReturn,
  subtractYears,
  type BenchmarkPeriodKey,
} from "@/lib/benchmark/math";

export interface AccountBenchmarkResult {
  scope: "ACCOUNT";
  accountId: string;
  accountName: string;
  accountType: string;
  isLocked: boolean;
  period: BenchmarkPeriodKey;
  asOfDate: Date;
  requestedStartDate: Date;
  actualStartDate: Date | null;
  startValue: number | null;
  endValue: number;
  portfolioReturn: number | null;
  sp500Return: number | null;
  alpha: number | null;
  insufficientHistory: boolean;
  importBatchId: string;
}

export interface AggregateBenchmarkResult {
  scope: "AGGREGATE_TOTAL" | "AGGREGATE_ACTIONABLE";
  period: BenchmarkPeriodKey;
  asOfDate: Date;
  requestedStartDate: Date;
  actualStartDate: Date | null;
  /** Current value of every account in this scope, right now — always present. */
  currentValue: number;
  /** Value used as the return calculation's start point (matched-subset only). */
  startValue: number | null;
  /** Value used as the return calculation's end point (matched-subset only, <= currentValue). */
  endValue: number | null;
  portfolioReturn: number | null;
  sp500Return: number | null;
  alpha: number | null;
  insufficientHistory: boolean;
  accountIds: string[];
  excludedAccountIds: string[];
  importBatchId: string;
}

export interface BenchmarkComputation {
  computedAt: Date;
  totalCurrentValue: number;
  accounts: AccountBenchmarkResult[];
  aggregate: AggregateBenchmarkResult[];
}

async function resolveStartSnapshot(
  accountId: string,
  latestBatchId: string,
  requestedStartDate: Date,
): Promise<{ snapshot: AccountSnapshotValue | null; insufficientHistory: boolean }> {
  const onOrBefore = await getAccountSnapshot(accountId, requestedStartDate);
  if (onOrBefore && onOrBefore.importBatchId !== latestBatchId) {
    return { snapshot: onOrBefore, insufficientHistory: false };
  }

  // No snapshot old enough to satisfy the window — fall back to the
  // earliest one we have (if it's distinct from "now"), flagged as partial.
  const earliest = await getEarliestAccountSnapshot(accountId);
  if (earliest && earliest.importBatchId !== latestBatchId) {
    return { snapshot: earliest, insufficientHistory: true };
  }
  return { snapshot: null, insufficientHistory: true };
}

/** Most recently uploaded batch across a set of accounts — used as the FK anchor for aggregate rows. */
async function latestBatchIdAcrossAccounts(accountIds: string[]): Promise<string | null> {
  const batch = await prisma.importBatch.findFirst({
    where: { accountId: { in: accountIds } },
    orderBy: { uploadedAt: "desc" },
    select: { id: true },
  });
  return batch?.id ?? null;
}

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

  const accountResults: AccountBenchmarkResult[] = [];
  // Reused by the aggregate pass so we don't refetch each (account, period) twice.
  const startByAccountPeriod = new Map<
    string,
    { snapshot: AccountSnapshotValue | null; insufficientHistory: boolean }
  >();

  for (const account of accountsWithData) {
    const latest = latestByAccount.get(account.id)!;
    for (const { key, years } of BENCHMARK_PERIODS) {
      const requestedStartDate = subtractYears(latest.asOfDate, years);
      const { snapshot: startSnap, insufficientHistory } = await resolveStartSnapshot(
        account.id,
        latest.importBatchId,
        requestedStartDate,
      );
      startByAccountPeriod.set(`${account.id}:${key}`, { snapshot: startSnap, insufficientHistory });

      const sp500Start = await getSp500CloseOnOrBefore(requestedStartDate);
      const sp500End = await getSp500CloseOnOrBefore(latest.asOfDate);
      const sp500Return =
        sp500Start && sp500End ? computeReturn(sp500Start.close, sp500End.close) : null;

      const portfolioReturn = startSnap ? computeReturn(startSnap.totalValue, latest.totalValue) : null;

      accountResults.push({
        scope: "ACCOUNT",
        accountId: account.id,
        accountName: account.name,
        accountType: account.type,
        isLocked: account.isLocked,
        period: key,
        asOfDate: latest.asOfDate,
        requestedStartDate,
        actualStartDate: startSnap?.asOfDate ?? null,
        startValue: startSnap?.totalValue ?? null,
        endValue: latest.totalValue,
        portfolioReturn,
        sp500Return,
        alpha: computeAlpha(portfolioReturn, sp500Return),
        insufficientHistory: insufficientHistory || portfolioReturn == null,
        importBatchId: latest.importBatchId,
      });
    }
  }

  const aggregateResults: AggregateBenchmarkResult[] = [];
  const scopes: Array<{ scope: BenchmarkScope; accounts: Account[] }> = [
    { scope: "AGGREGATE_TOTAL", accounts: accountsWithData },
    { scope: "AGGREGATE_ACTIONABLE", accounts: accountsWithData.filter((a) => !a.isLocked) },
  ];

  for (const { key, years } of BENCHMARK_PERIODS) {
    for (const { scope, accounts: scopeAccounts } of scopes) {
      // Nothing to compute (e.g. no unlocked accounts yet for ACTIONABLE) —
      // and no ImportBatch to anchor a row to, so skip entirely.
      if (scopeAccounts.length === 0) continue;

      const currentValue = scopeAccounts.reduce(
        (sum, a) => sum + latestByAccount.get(a.id)!.totalValue,
        0,
      );

      const asOfDate =
        scopeAccounts.length > 0
          ? new Date(Math.max(...scopeAccounts.map((a) => latestByAccount.get(a.id)!.asOfDate.getTime())))
          : new Date();
      const requestedStartDate = subtractYears(asOfDate, years);

      const included: Account[] = [];
      const excluded: Account[] = [];
      let startValue = 0;
      let endValue = 0;
      let actualStartDate: Date | null = null;
      let anyIncludedAccountHasPartialWindow = false;

      for (const account of scopeAccounts) {
        const start = startByAccountPeriod.get(`${account.id}:${key}`);
        const latest = latestByAccount.get(account.id)!;
        if (start?.snapshot) {
          included.push(account);
          startValue += start.snapshot.totalValue;
          endValue += latest.totalValue;
          if (start.insufficientHistory) anyIncludedAccountHasPartialWindow = true;
          if (!actualStartDate || start.snapshot.asOfDate.getTime() > actualStartDate.getTime()) {
            actualStartDate = start.snapshot.asOfDate;
          }
        } else {
          excluded.push(account);
        }
      }

      const sp500Start = await getSp500CloseOnOrBefore(requestedStartDate);
      const sp500End = await getSp500CloseOnOrBefore(asOfDate);
      const sp500Return =
        sp500Start && sp500End ? computeReturn(sp500Start.close, sp500End.close) : null;
      const portfolioReturn = included.length > 0 ? computeReturn(startValue, endValue) : null;

      const anchorBatchId =
        (await latestBatchIdAcrossAccounts(scopeAccounts.map((a) => a.id))) ?? "";

      aggregateResults.push({
        scope: scope as "AGGREGATE_TOTAL" | "AGGREGATE_ACTIONABLE",
        period: key,
        asOfDate,
        requestedStartDate,
        actualStartDate,
        currentValue,
        startValue: included.length > 0 ? startValue : null,
        endValue: included.length > 0 ? endValue : null,
        portfolioReturn,
        sp500Return,
        alpha: computeAlpha(portfolioReturn, sp500Return),
        insufficientHistory:
          excluded.length > 0 || anyIncludedAccountHasPartialWindow || portfolioReturn == null,
        accountIds: included.map((a) => a.id),
        excludedAccountIds: excluded.map((a) => a.id),
        importBatchId: anchorBatchId,
      });
    }
  }

  return {
    computedAt: new Date(),
    totalCurrentValue,
    accounts: accountResults,
    aggregate: aggregateResults,
  };
}
