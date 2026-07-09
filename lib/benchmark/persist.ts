import { prisma } from "@/lib/prisma";
import type { BenchmarkComputation } from "@/lib/benchmark/engine";

/**
 * Upserts computed results into BenchmarkResult, keyed by
 * (importBatchId, scope, accountId, period). Re-running the computation
 * against the same batch updates the existing row instead of piling up
 * duplicates; a new ImportBatch naturally produces a new row.
 */
export async function persistBenchmarkResults(computation: BenchmarkComputation): Promise<void> {
  for (const result of computation.accounts) {
    const existing = await prisma.benchmarkResult.findFirst({
      where: {
        importBatchId: result.importBatchId,
        scope: "ACCOUNT",
        accountId: result.accountId,
        period: result.period,
      },
      select: { id: true },
    });

    const data = {
      importBatchId: result.importBatchId,
      scope: "ACCOUNT" as const,
      accountId: result.accountId,
      period: result.period,
      asOfDate: result.asOfDate,
      requestedStartDate: result.requestedStartDate,
      actualStartDate: result.actualStartDate,
      startValue: result.startValue,
      endValue: result.endValue,
      portfolioReturn: result.portfolioReturn,
      sp500Return: result.sp500Return,
      alpha: result.alpha,
      insufficientHistory: result.insufficientHistory,
    };

    if (existing) {
      await prisma.benchmarkResult.update({ where: { id: existing.id }, data });
    } else {
      await prisma.benchmarkResult.create({ data });
    }
  }

  for (const result of computation.aggregate) {
    const existing = await prisma.benchmarkResult.findFirst({
      where: {
        importBatchId: result.importBatchId,
        scope: result.scope,
        accountId: null,
        period: result.period,
      },
      select: { id: true },
    });

    const data = {
      importBatchId: result.importBatchId,
      scope: result.scope,
      accountId: null,
      period: result.period,
      asOfDate: result.asOfDate,
      requestedStartDate: result.requestedStartDate,
      actualStartDate: result.actualStartDate,
      startValue: result.startValue,
      endValue: result.endValue,
      portfolioReturn: result.portfolioReturn,
      sp500Return: result.sp500Return,
      alpha: result.alpha,
      insufficientHistory: result.insufficientHistory,
    };

    if (existing) {
      await prisma.benchmarkResult.update({ where: { id: existing.id }, data });
    } else {
      await prisma.benchmarkResult.create({ data });
    }
  }
}
