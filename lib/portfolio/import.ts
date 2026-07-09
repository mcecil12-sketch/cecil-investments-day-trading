import { prisma } from "@/lib/prisma";
import type { ImportBatchStatus } from "@/lib/generated/prisma";
import {
  parseFidelityPositionsCsv,
  type FidelityAccountGroup,
  type FidelityHoldingRow,
} from "@/lib/portfolio/csv/fidelity";

export interface ImportBatchResult {
  accountId: string;
  accountExternalId: string;
  accountName: string;
  accountCreated: boolean;
  status: ImportBatchStatus;
  rowCount: number;
  errorMessage: string | null;
}

export interface ImportFidelityCsvResult {
  asOfDate: Date;
  parserWarnings: string[];
  batches: ImportBatchResult[];
}

export interface ImportFidelityCsvInput {
  csvText: string;
  fileName: string;
  asOfDate?: Date;
}

/**
 * Persists one account's holdings for a single as-of snapshot: an Instrument
 * upsert per row, a Holding per row, and an ImportBatch tying them together
 * with a COMPLETE/FAILED status. Shared by every import source (CSV rows
 * today, AI-extracted screenshot rows) so they land in the same benchmark
 * pipeline regardless of how the rows were produced.
 */
export async function importHoldingsBatch(input: {
  accountId: string;
  source: string;
  fileName: string;
  asOfDate: Date;
  rows: FidelityHoldingRow[];
}): Promise<{ status: ImportBatchStatus; rowCount: number; errorMessage: string | null }> {
  const batch = await prisma.importBatch.create({
    data: {
      accountId: input.accountId,
      source: input.source,
      fileName: input.fileName,
      asOfDate: input.asOfDate,
      status: "PENDING",
      rowCount: input.rows.length,
    },
  });

  try {
    await prisma.$transaction(async (tx) => {
      for (const row of input.rows) {
        const instrument = await tx.instrument.upsert({
          where: { symbol: row.symbol },
          create: { symbol: row.symbol, name: row.description || null, type: row.type },
          update: { type: row.type, name: row.description || undefined },
        });

        await tx.holding.create({
          data: {
            accountId: input.accountId,
            instrumentId: instrument.id,
            importBatchId: batch.id,
            asOfDate: input.asOfDate,
            quantity: row.quantity ?? 0,
            lastPrice: row.lastPrice,
            currentValue: row.currentValue,
            costBasisTotal: row.costBasisTotal,
            averageCostBasis: row.averageCostBasis,
            percentOfAccount: row.percentOfAccount,
          },
        });
      }
    });

    const completed = await prisma.importBatch.update({
      where: { id: batch.id },
      data: { status: "COMPLETE" },
    });

    return { status: completed.status, rowCount: completed.rowCount, errorMessage: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failed = await prisma.importBatch.update({
      where: { id: batch.id },
      data: { status: "FAILED", errorMessage: message },
    });

    return { status: failed.status, rowCount: 0, errorMessage: message };
  }
}

async function importAccountGroup(
  group: FidelityAccountGroup,
  fileName: string,
  asOfDate: Date,
): Promise<ImportBatchResult> {
  let account = await prisma.account.findUnique({ where: { externalId: group.externalId } });
  let accountCreated = false;

  if (!account) {
    account = await prisma.account.create({
      data: {
        name: group.accountName,
        type: "FIDELITY_TAXABLE",
        institution: "Fidelity",
        externalId: group.externalId,
      },
    });
    accountCreated = true;
  }

  const result = await importHoldingsBatch({
    accountId: account.id,
    source: "fidelity",
    fileName,
    asOfDate,
    rows: group.rows,
  });

  return {
    accountId: account.id,
    accountExternalId: group.externalId,
    accountName: account.name,
    accountCreated,
    ...result,
  };
}

/**
 * A single Fidelity export can cover several linked accounts at once, so
 * each account group gets its own ImportBatch and independent success/failure
 * status rather than the whole upload succeeding or failing as a unit.
 */
export async function importFidelityCsv(input: ImportFidelityCsvInput): Promise<ImportFidelityCsvResult> {
  const parsed = parseFidelityPositionsCsv(input.csvText);
  const asOfDate = input.asOfDate ?? parsed.asOfDate ?? new Date();

  const batches: ImportBatchResult[] = [];
  for (const group of parsed.accounts) {
    batches.push(await importAccountGroup(group, input.fileName, asOfDate));
  }

  return { asOfDate, parserWarnings: parsed.warnings, batches };
}
