import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  PERFORMANCE_PERIOD_KEYS,
  type ExtractedAccountReturns,
  type ExtractedSp500Returns,
} from "@/lib/portfolio/performancePdfImport";

interface ConfirmAccountInput {
  accountId: string;
  returns: ExtractedAccountReturns;
}

interface ConfirmAccountResult {
  accountId: string;
  accountName: string | null;
  status: string;
  periodCount: number;
  errorMessage: string | null;
}

interface PerformanceRow {
  period: string;
  returnPct: number;
  sp500ReturnPct: number | null;
  startDate: Date | null;
}

function buildRows(returns: ExtractedAccountReturns, sp500: ExtractedSp500Returns): PerformanceRow[] {
  const rows: PerformanceRow[] = [];
  for (const { field, period } of PERFORMANCE_PERIOD_KEYS) {
    const returnPct = returns[field];
    if (returnPct == null) continue;
    rows.push({ period, returnPct, sp500ReturnPct: sp500[field], startDate: null });
  }
  if (returns.lifeOfData != null) {
    rows.push({
      period: "life",
      returnPct: returns.lifeOfData,
      sp500ReturnPct: null,
      startDate: returns.lifeOfDataStartDate ? new Date(returns.lifeOfDataStartDate) : null,
    });
  }
  return rows;
}

async function importAccountReturns(
  account: ConfirmAccountInput,
  sp500: ExtractedSp500Returns,
  asOfDate: Date,
  fileName: string,
): Promise<ConfirmAccountResult> {
  const dbAccount = await prisma.account.findUnique({ where: { id: account.accountId } });
  if (!dbAccount) {
    return {
      accountId: account.accountId,
      accountName: null,
      status: "FAILED",
      periodCount: 0,
      errorMessage: "Account not found",
    };
  }

  const rows = buildRows(account.returns, sp500);

  const batch = await prisma.importBatch.create({
    data: {
      accountId: dbAccount.id,
      source: "performance-pdf",
      fileName,
      asOfDate,
      status: "PENDING",
      rowCount: rows.length,
    },
  });

  try {
    await prisma.$transaction(
      rows.map((row) =>
        prisma.accountPerformance.upsert({
          where: { accountId_period_asOfDate: { accountId: dbAccount.id, period: row.period, asOfDate } },
          create: {
            accountId: dbAccount.id,
            period: row.period,
            returnPct: row.returnPct,
            sp500ReturnPct: row.sp500ReturnPct,
            alpha: row.sp500ReturnPct != null ? row.returnPct - row.sp500ReturnPct : null,
            startDate: row.startDate,
            asOfDate,
          },
          update: {
            returnPct: row.returnPct,
            sp500ReturnPct: row.sp500ReturnPct,
            alpha: row.sp500ReturnPct != null ? row.returnPct - row.sp500ReturnPct : null,
            startDate: row.startDate,
          },
        }),
      ),
    );

    const completed = await prisma.importBatch.update({ where: { id: batch.id }, data: { status: "COMPLETE" } });
    return {
      accountId: dbAccount.id,
      accountName: dbAccount.name,
      status: completed.status,
      periodCount: rows.length,
      errorMessage: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.importBatch.update({ where: { id: batch.id }, data: { status: "FAILED", errorMessage: message } });
    return { accountId: dbAccount.id, accountName: dbAccount.name, status: "FAILED", periodCount: 0, errorMessage: message };
  }
}

/**
 * Persists the Performance PDF's Total row as isAggregate rows (accountId
 * null). There's no ImportBatch for this — it isn't tied to any one account —
 * and no DB unique constraint dedupes it (Postgres treats NULL accountId
 * values as distinct in the (accountId, period, asOfDate) index), so a
 * re-upload for the same as-of date is upserted here by an explicit
 * find-then-write instead of prisma's upsert().
 */
async function importTotalPortfolioReturns(
  totalPortfolio: ExtractedAccountReturns,
  sp500: ExtractedSp500Returns,
  asOfDate: Date,
): Promise<number> {
  const rows = buildRows(totalPortfolio, sp500);

  for (const row of rows) {
    const existing = await prisma.accountPerformance.findFirst({
      where: { isAggregate: true, period: row.period, asOfDate },
      select: { id: true },
    });
    const data = {
      accountId: null,
      isAggregate: true,
      period: row.period,
      returnPct: row.returnPct,
      sp500ReturnPct: row.sp500ReturnPct,
      alpha: row.sp500ReturnPct != null ? row.returnPct - row.sp500ReturnPct : null,
      startDate: row.startDate,
      asOfDate,
    };
    if (existing) {
      await prisma.accountPerformance.update({ where: { id: existing.id }, data });
    } else {
      await prisma.accountPerformance.create({ data });
    }
  }

  return rows.length;
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);

  if (!body || !Array.isArray(body.accounts) || body.accounts.length === 0) {
    return NextResponse.json({ error: "accounts must be a non-empty array" }, { status: 400 });
  }

  const asOfDate = body.asOfDate ? new Date(body.asOfDate) : new Date();
  if (Number.isNaN(asOfDate.getTime())) {
    return NextResponse.json({ error: "asOfDate is not a valid date" }, { status: 400 });
  }

  const sp500 = body.benchmarks?.sp500 as ExtractedSp500Returns | undefined;
  if (!sp500) {
    return NextResponse.json({ error: "benchmarks.sp500 is required" }, { status: 400 });
  }

  const fileName = typeof body.fileName === "string" ? body.fileName : "performance-pdf-import.pdf";
  const accountInputs = body.accounts as ConfirmAccountInput[];
  const totalPortfolio = body.totalPortfolio as ExtractedAccountReturns | null | undefined;

  for (const account of accountInputs) {
    if (!account || typeof account.accountId !== "string" || !account.accountId.trim() || !account.returns) {
      return NextResponse.json(
        { error: "Each account requires an accountId and a returns object" },
        { status: 400 },
      );
    }
  }

  const results: ConfirmAccountResult[] = [];
  for (const account of accountInputs) {
    results.push(await importAccountReturns(account, sp500, asOfDate, fileName));
  }

  const totalPortfolioPeriodCount = totalPortfolio
    ? await importTotalPortfolioReturns(totalPortfolio, sp500, asOfDate)
    : 0;

  const completed = results.filter((r) => r.status === "COMPLETE");

  return NextResponse.json({
    accountsImported: completed.length,
    batches: results,
    totalPortfolioPeriodCount,
  });
}
