import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * Marks a CIO recommendation (identified by weeklyBriefId + its position in
 * that week's action item list) as executed or skipped, with optional notes.
 * Re-marking always resets outcome30d/outcome90d to null — the executed date
 * moves, so any previously computed relative performance no longer applies.
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);

  if (!body || typeof body.weeklyBriefId !== "string" || !body.weeklyBriefId) {
    return NextResponse.json({ error: "weeklyBriefId is required" }, { status: 400 });
  }
  if (typeof body.actionItemIndex !== "number" || !Number.isInteger(body.actionItemIndex)) {
    return NextResponse.json({ error: "actionItemIndex must be an integer" }, { status: 400 });
  }

  const weeklyBriefId: string = body.weeklyBriefId;
  const actionItemIndex: number = body.actionItemIndex;
  const executed = Boolean(body.executed);
  const notes = typeof body.notes === "string" ? body.notes : undefined;

  const data = {
    executed,
    executedDate: executed ? new Date() : null,
    outcome30d: null,
    outcome90d: null,
    notes,
  };

  const outcome = await prisma.recommendationOutcome.upsert({
    where: { weeklyBriefId_actionItemIndex: { weeklyBriefId, actionItemIndex } },
    create: { weeklyBriefId, actionItemIndex, ...data },
    update: data,
  });

  return NextResponse.json(outcome);
}
