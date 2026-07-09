import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseFidelityPositionsCsv } from "@/lib/portfolio/csv/fidelity";

export interface PreviewAccountGroup {
  externalId: string;
  accountName: string;
  rowCount: number;
  accountExists: boolean;
  existingAccountName: string | null;
}

export interface FidelityPreviewResult {
  asOfDate: string | null;
  warnings: string[];
  accounts: PreviewAccountGroup[];
}

export async function POST(request: NextRequest) {
  const formData = await request.formData().catch(() => null);
  const file = formData?.get("file");

  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' in form data" }, { status: 400 });
  }

  const csvText = await file.text();
  if (!csvText.trim()) {
    return NextResponse.json({ error: "Uploaded file is empty" }, { status: 400 });
  }

  const parsed = parseFidelityPositionsCsv(csvText);

  const accounts: PreviewAccountGroup[] = await Promise.all(
    parsed.accounts.map(async (group) => {
      const existing = await prisma.account.findUnique({
        where: { externalId: group.externalId },
        select: { name: true },
      });
      return {
        externalId: group.externalId,
        accountName: group.accountName,
        rowCount: group.rows.length,
        accountExists: existing != null,
        existingAccountName: existing?.name ?? null,
      };
    }),
  );

  const result: FidelityPreviewResult = {
    asOfDate: parsed.asOfDate ? parsed.asOfDate.toISOString() : null,
    warnings: parsed.warnings,
    accounts,
  };

  return NextResponse.json(result);
}
