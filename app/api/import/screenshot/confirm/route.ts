import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { importHoldingsBatch } from "@/lib/portfolio/import";
import { positionsToHoldingRows, type ExtractedPosition } from "@/lib/portfolio/screenshotImport";
import { triggerRelativeStrengthRun } from "@/lib/agents/runner";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);

  if (!body || typeof body.accountId !== "string" || !body.accountId.trim()) {
    return NextResponse.json({ error: "accountId is required" }, { status: 400 });
  }
  if (!Array.isArray(body.positions) || body.positions.length === 0) {
    return NextResponse.json({ error: "positions must be a non-empty array" }, { status: 400 });
  }

  const asOfDate = body.asOfDate ? new Date(body.asOfDate) : new Date();
  if (Number.isNaN(asOfDate.getTime())) {
    return NextResponse.json({ error: "asOfDate is not a valid date" }, { status: 400 });
  }

  const account = await prisma.account.findUnique({ where: { id: body.accountId } });
  if (!account) {
    return NextResponse.json({ error: "Account not found" }, { status: 404 });
  }

  const rows = positionsToHoldingRows(body.positions as ExtractedPosition[]);

  const result = await importHoldingsBatch({
    accountId: account.id,
    source: "screenshot",
    fileName: typeof body.fileName === "string" ? body.fileName : "screenshot",
    asOfDate,
    rows,
  });

  if (result.status === "COMPLETE") {
    triggerRelativeStrengthRun();
  }

  return NextResponse.json({
    accountId: account.id,
    accountName: account.name,
    ...result,
  });
}
