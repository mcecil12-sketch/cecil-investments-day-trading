import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { importHoldingsBatch } from "@/lib/portfolio/import";
import { pdfPositionsToHoldingRows, type ExtractedPdfPosition } from "@/lib/portfolio/pdfImport";
import { triggerAllAgentsRun } from "@/lib/agents/runner";

interface ConfirmAccountInput {
  accountId: string;
  positions: ExtractedPdfPosition[];
}

interface ConfirmAccountResult {
  accountId: string;
  accountName: string | null;
  status: string;
  rowCount: number;
  errorMessage: string | null;
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

  const fileName = typeof body.fileName === "string" ? body.fileName : "pdf-import.pdf";
  const accountInputs = body.accounts as ConfirmAccountInput[];

  for (const account of accountInputs) {
    if (
      !account ||
      typeof account.accountId !== "string" ||
      !account.accountId.trim() ||
      !Array.isArray(account.positions) ||
      account.positions.length === 0
    ) {
      return NextResponse.json(
        { error: "Each account requires an accountId and a non-empty positions array" },
        { status: 400 },
      );
    }
  }

  const batches: ConfirmAccountResult[] = [];
  for (const account of accountInputs) {
    const dbAccount = await prisma.account.findUnique({ where: { id: account.accountId } });
    if (!dbAccount) {
      batches.push({
        accountId: account.accountId,
        accountName: null,
        status: "FAILED",
        rowCount: 0,
        errorMessage: "Account not found",
      });
      continue;
    }

    const rows = pdfPositionsToHoldingRows(account.positions);
    const result = await importHoldingsBatch({
      accountId: dbAccount.id,
      source: "pdf",
      fileName,
      asOfDate,
      rows,
    });
    batches.push({ accountId: dbAccount.id, accountName: dbAccount.name, ...result });
  }

  const completed = batches.filter((batch) => batch.status === "COMPLETE");
  if (completed.length > 0) {
    triggerAllAgentsRun();
  }

  return NextResponse.json({
    accountsImported: completed.length,
    positionsImported: completed.reduce((sum, batch) => sum + batch.rowCount, 0),
    batches,
  });
}
