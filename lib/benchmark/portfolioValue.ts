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
  for (const holding of holdings) {
    totalValue += holding.currentValue;
    if (isLockedInstrument(holding.instrument)) lockedValue += holding.currentValue;
  }

  return {
    accountId,
    importBatchId: batch.id,
    asOfDate: batch.asOfDate,
    totalValue,
    lockedValue,
    actionableValue: totalValue - lockedValue,
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
  const batch = await prisma.importBatch.findFirst({
    where: {
      accountId,
      status: { in: USABLE_STATUSES },
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
  const batch = await prisma.importBatch.findFirst({
    where: { accountId, status: { in: USABLE_STATUSES } },
    orderBy: [{ asOfDate: "asc" }, { uploadedAt: "asc" }],
    select: { id: true, asOfDate: true },
  });
  return toSnapshotValue(accountId, batch);
}
