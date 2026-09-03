import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getPriceHistory } from "@/lib/agents/marketData";
import { parseGrantYear, type ExtractedVzLtiTranche } from "@/lib/portfolio/vzLtiImport";

const VZ_SYMBOL = "VZ";

function isExtractedVzLtiTranche(value: unknown): value is ExtractedVzLtiTranche {
  if (!value || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.cohortLabel === "string" &&
    typeof t.vestDate === "string" &&
    typeof t.shares === "number" &&
    Number.isFinite(t.shares)
  );
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);

  if (!body || typeof body.accountId !== "string" || !body.accountId.trim()) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }
  if (!Array.isArray(body.tranches) || body.tranches.length === 0 || !body.tranches.every(isExtractedVzLtiTranche)) {
    return NextResponse.json({ error: "tranches must be a non-empty array" }, { status: 400 });
  }

  const account = await prisma.account.findUnique({ where: { id: body.accountId } });
  if (!account) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }
  if (account.type !== "VZ_LTI") {
    return NextResponse.json({ error: "Account is not a VZ_LTI account" }, { status: 400 });
  }

  const asOfDate = body.asOfDate ? new Date(body.asOfDate) : new Date();
  if (Number.isNaN(asOfDate.getTime())) {
    return NextResponse.json({ error: "asOfDate is not a valid date" }, { status: 400 });
  }

  const tranches = body.tranches as ExtractedVzLtiTranche[];
  const grantYearByLabel = new Map<string, number>();
  for (const tranche of tranches) {
    const grantYear = parseGrantYear(tranche.cohortLabel);
    if (grantYear == null) {
      return NextResponse.json(
        { error: `Couldn't parse a grant year out of cohort label "${tranche.cohortLabel}"` },
        { status: 400 },
      );
    }
    grantYearByLabel.set(tranche.cohortLabel, grantYear);
  }

  // currentValue is computed here, once, from the same live price source
  // every other symbol in the app uses — then frozen into the row. Never
  // recomputed later against a newer price (see VzLtiTranche's schema doc).
  let vzPrice: number;
  try {
    const { points } = await getPriceHistory(VZ_SYMBOL);
    const latest = [...points].sort((a, b) => a.date.getTime() - b.date.getTime()).at(-1);
    if (!latest) throw new Error("no price points returned");
    vzPrice = latest.close;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Couldn't fetch VZ's current price: ${message}` }, { status: 502 });
  }

  const fileName = typeof body.fileName === "string" ? body.fileName : "vz-lti-import.png";

  const batch = await prisma.importBatch.create({
    data: {
      accountId: account.id,
      source: "vz-lti",
      fileName,
      asOfDate,
      status: "PENDING",
      rowCount: tranches.length,
    },
  });

  try {
    await prisma.vzLtiTranche.createMany({
      data: tranches.map((t) => ({
        accountId: account.id,
        importBatchId: batch.id,
        cohortLabel: t.cohortLabel,
        grantYear: grantYearByLabel.get(t.cohortLabel)!,
        vestDate: new Date(t.vestDate),
        shares: t.shares,
        currentValue: t.shares * vzPrice,
      })),
    });

    const completed = await prisma.importBatch.update({ where: { id: batch.id }, data: { status: "COMPLETE" } });

    const totalShares = tranches.reduce((sum, t) => sum + t.shares, 0);
    return NextResponse.json({
      status: completed.status,
      trancheCount: tranches.length,
      totalShares,
      vzPrice,
      totalValue: totalShares * vzPrice,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.importBatch.update({ where: { id: batch.id }, data: { status: "FAILED", errorMessage: message } });
    return NextResponse.json({ error: `Import failed: ${message}` }, { status: 500 });
  }
}
