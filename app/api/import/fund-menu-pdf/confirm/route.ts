import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { ExtractedFundMenuEntry } from "@/lib/portfolio/fundMenuPdfImport";

interface ConfirmAccountInput {
  accountId: string;
  funds: ExtractedFundMenuEntry[];
}

interface ConfirmAccountResult {
  accountId: string;
  accountName: string | null;
  status: string;
  rowCount: number;
  errorMessage: string | null;
}

/**
 * Persists one plan's complete fund menu, scoped to its own accountId so it
 * can never collide with another plan's same-named fund (see
 * PlanFundMenuEntry's schema comment). Upserts by (accountId, fundName) —
 * a re-upload of the same plan's menu replaces each fund's figures rather
 * than duplicating rows, same convention as the Positions/Performance PDF
 * imports.
 */
async function importFundMenu(
  account: ConfirmAccountInput,
  asOfDate: Date,
  fileName: string,
): Promise<ConfirmAccountResult> {
  const dbAccount = await prisma.account.findUnique({ where: { id: account.accountId } });
  if (!dbAccount) {
    return { accountId: account.accountId, accountName: null, status: "FAILED", rowCount: 0, errorMessage: "Account not found" };
  }

  const batch = await prisma.importBatch.create({
    data: {
      accountId: dbAccount.id,
      source: "fund-menu-pdf",
      fileName,
      asOfDate,
      status: "PENDING",
      rowCount: account.funds.length,
    },
  });

  try {
    await prisma.$transaction(
      account.funds.map((fund) =>
        prisma.planFundMenuEntry.upsert({
          where: { accountId_fundName: { accountId: dbAccount.id, fundName: fund.fundName } },
          create: {
            accountId: dbAccount.id,
            fundName: fund.fundName,
            assetClass: fund.assetClass,
            ticker: fund.ticker,
            oneYear: fund.oneYear,
            threeYear: fund.threeYear,
            fiveYear: fund.fiveYear,
            tenYear: fund.tenYear,
            inceptionDate: fund.inceptionDate ? new Date(fund.inceptionDate) : null,
            isHeld: fund.isHeld,
            asOfDate,
            importBatchId: batch.id,
          },
          update: {
            assetClass: fund.assetClass,
            ticker: fund.ticker,
            oneYear: fund.oneYear,
            threeYear: fund.threeYear,
            fiveYear: fund.fiveYear,
            tenYear: fund.tenYear,
            inceptionDate: fund.inceptionDate ? new Date(fund.inceptionDate) : null,
            isHeld: fund.isHeld,
            asOfDate,
            importBatchId: batch.id,
          },
        }),
      ),
    );

    const completed = await prisma.importBatch.update({ where: { id: batch.id }, data: { status: "COMPLETE" } });
    return { accountId: dbAccount.id, accountName: dbAccount.name, status: completed.status, rowCount: account.funds.length, errorMessage: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.importBatch.update({ where: { id: batch.id }, data: { status: "FAILED", errorMessage: message } });
    return { accountId: dbAccount.id, accountName: dbAccount.name, status: "FAILED", rowCount: 0, errorMessage: message };
  }
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

  const fileName = typeof body.fileName === "string" ? body.fileName : "fund-menu-pdf-import.pdf";
  const accountInputs = body.accounts as ConfirmAccountInput[];

  for (const account of accountInputs) {
    if (
      !account ||
      typeof account.accountId !== "string" ||
      !account.accountId.trim() ||
      !Array.isArray(account.funds) ||
      account.funds.length === 0
    ) {
      return NextResponse.json(
        { error: "Each account requires an accountId and a non-empty funds array" },
        { status: 400 },
      );
    }
  }

  const batches: ConfirmAccountResult[] = [];
  for (const account of accountInputs) {
    batches.push(await importFundMenu(account, asOfDate, fileName));
  }

  const completed = batches.filter((batch) => batch.status === "COMPLETE");

  return NextResponse.json({
    accountsImported: completed.length,
    fundsImported: completed.reduce((sum, batch) => sum + batch.rowCount, 0),
    batches,
  });
}
