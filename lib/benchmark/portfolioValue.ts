import { prisma } from "@/lib/prisma";
import { ImportBatchStatus } from "@/lib/generated/prisma";

export interface AccountSnapshotValue {
  accountId: string;
  importBatchId: string;
  asOfDate: Date;
  totalValue: number;
}

const USABLE_STATUSES: ImportBatchStatus[] = ["COMPLETE", "PARTIAL"];

async function toSnapshotValue(
  accountId: string,
  batch: { id: string; asOfDate: Date } | null,
): Promise<AccountSnapshotValue | null> {
  if (!batch) return null;
  const agg = await prisma.holding.aggregate({
    where: { importBatchId: batch.id },
    _sum: { currentValue: true },
  });
  return {
    accountId,
    importBatchId: batch.id,
    asOfDate: batch.asOfDate,
    totalValue: agg._sum.currentValue ?? 0,
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
