import { prisma } from "@/lib/prisma";
import { ImportBatchStatus } from "@/lib/generated/prisma";
import { isLockedInstrument } from "@/lib/benchmark/lockedHoldings";

export interface AccountSnapshotValue {
  accountId: string;
  importBatchId: string;
  asOfDate: Date;
  /** Full value of every holding, including locked (non-actionable) funds. */
  totalValue: number;
  /** Value of holdings that can't be reallocated (e.g. a locked company stock fund) — excluded from return/alpha. */
  lockedValue: number;
  /** totalValue minus lockedValue — what actually participates in return/alpha calculations. */
  actionableValue: number;
  /** Sum of each holding's cost basis; holdings missing a cost basis (e.g. cash sweep) fall back to their current value so they read as flat rather than skewing the total. */
  costBasisTotal: number;
}

const USABLE_STATUSES: ImportBatchStatus[] = ["COMPLETE", "PARTIAL"];

async function toSnapshotValue(
  accountId: string,
  batch: { id: string; asOfDate: Date } | null,
): Promise<AccountSnapshotValue | null> {
  if (!batch) return null;
  const holdings = await prisma.holding.findMany({
    where: { importBatchId: batch.id },
    include: { instrument: true },
  });

  let totalValue = 0;
  let lockedValue = 0;
  let costBasisTotal = 0;
  for (const holding of holdings) {
    totalValue += holding.currentValue;
    if (isLockedInstrument(holding.instrument)) lockedValue += holding.currentValue;
    costBasisTotal += holding.costBasisTotal ?? holding.currentValue;
  }

  return {
    accountId,
    importBatchId: batch.id,
    asOfDate: batch.asOfDate,
    totalValue,
    lockedValue,
    actionableValue: totalValue - lockedValue,
    costBasisTotal,
  };
}

/**
 * VZ_LTI's snapshot: unlike every other account type, its value doesn't
 * live in Holding rows at all — it's summed from VzLtiTranche.currentValue
 * (shares × VZ's price at import time, already frozen there — see
 * VzLtiTranche's schema doc comment). 100% locked: this account is single-
 * stock company compensation the whole time it's held, never a mix of
 * actionable and non-actionable funds the way VZ_EDP is, so unlike EDP's
 * per-instrument partial lock, the entire balance counts as lockedValue.
 * costBasisTotal mirrors totalValue (flat, zero implied gain) only because
 * this account is excluded from the since-purchase return calc entirely
 * (lib/benchmark/engine.ts) — there's no real purchase cost basis for a
 * stock grant, so that number is never actually read.
 */
async function toVzLtiSnapshotValue(
  accountId: string,
  batch: { id: string; asOfDate: Date } | null,
): Promise<AccountSnapshotValue | null> {
  if (!batch) return null;
  const tranches = await prisma.vzLtiTranche.findMany({ where: { importBatchId: batch.id } });
  const totalValue = tranches.reduce((sum, t) => sum + t.currentValue, 0);

  return {
    accountId,
    importBatchId: batch.id,
    asOfDate: batch.asOfDate,
    totalValue,
    lockedValue: totalValue,
    actionableValue: 0,
    costBasisTotal: totalValue,
  };
}

/**
 * The account's most recent snapshot on or before `onOrBefore` (or the most
 * recent snapshot overall, if `onOrBefore` is omitted). Ties on asOfDate are
 * broken by upload recency so a corrected re-import wins.
 */
export async function getAccountSnapshot(
  accountId: string,
  onOrBefore?: Date,
): Promise<AccountSnapshotValue | null> {
  const account = await prisma.account.findUnique({ where: { id: accountId }, select: { type: true } });
  if (!account) return null;

  if (account.type === "VZ_LTI") {
    const batch = await prisma.importBatch.findFirst({
      where: {
        accountId,
        status: { in: USABLE_STATUSES },
        vzLtiTranches: { some: {} },
        ...(onOrBefore ? { asOfDate: { lte: onOrBefore } } : {}),
      },
      orderBy: [{ asOfDate: "desc" }, { uploadedAt: "desc" }],
      select: { id: true, asOfDate: true },
    });
    return toVzLtiSnapshotValue(accountId, batch);
  }

  const batch = await prisma.importBatch.findFirst({
    where: {
      accountId,
      status: { in: USABLE_STATUSES },
      // Some import sources (e.g. the Performance PDF, which carries only
      // rolling-period returns) legitimately create a COMPLETE batch with no
      // Holding rows at all. Without this filter, that batch can out-sort a
      // real holdings snapshot once its asOfDate catches up, collapsing the
      // account's value to zero even though the actual holdings data is
      // untouched.
      holdings: { some: {} },
      ...(onOrBefore ? { asOfDate: { lte: onOrBefore } } : {}),
    },
    orderBy: [{ asOfDate: "desc" }, { uploadedAt: "desc" }],
    select: { id: true, asOfDate: true },
  });
  return toSnapshotValue(accountId, batch);
}

/** The account's very first usable snapshot, regardless of date. */
export async function getEarliestAccountSnapshot(
  accountId: string,
): Promise<AccountSnapshotValue | null> {
  const account = await prisma.account.findUnique({ where: { id: accountId }, select: { type: true } });
  if (!account) return null;

  if (account.type === "VZ_LTI") {
    const batch = await prisma.importBatch.findFirst({
      where: { accountId, status: { in: USABLE_STATUSES }, vzLtiTranches: { some: {} } },
      orderBy: [{ asOfDate: "asc" }, { uploadedAt: "asc" }],
      select: { id: true, asOfDate: true },
    });
    return toVzLtiSnapshotValue(accountId, batch);
  }

  const batch = await prisma.importBatch.findFirst({
    where: { accountId, status: { in: USABLE_STATUSES }, holdings: { some: {} } },
    orderBy: [{ asOfDate: "asc" }, { uploadedAt: "asc" }],
    select: { id: true, asOfDate: true },
  });
  return toSnapshotValue(accountId, batch);
}
