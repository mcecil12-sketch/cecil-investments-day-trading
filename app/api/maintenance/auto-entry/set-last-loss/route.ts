import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { etDateString } from "@/lib/autoEntry/guardrails";
import { recordLoss } from "@/lib/autoEntry/guardrailsStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { atIso?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {}

  const lastLossAt = body.atIso ? String(body.atIso) : new Date().toISOString();
  const etDate = etDateString(new Date());

  try {
    await recordLoss(etDate, lastLossAt);
  } catch (err) {
    console.error("[set-last-loss] guardrail recordLoss failed", err);
  }

  return NextResponse.json({ ok: true, etDate, lastLossAt }, { status: 200 });
}
