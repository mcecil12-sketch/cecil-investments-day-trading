import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { etDateString } from "@/lib/autoEntry/guardrails";
import { resetGuardrails } from "@/lib/autoEntry/guardrailsStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { etDate?: string; resetFailuresOnly?: boolean } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {}

  const etDate = body.etDate ? body.etDate : etDateString(new Date());
  const resetFailuresOnly = body.resetFailuresOnly !== false;

  await resetGuardrails(etDate, {
    resetEntries: !resetFailuresOnly,
    resetFailures: true,
    clearAutoDisabled: true,
    clearLoss: true,
  });

  return NextResponse.json(
    {
      ok: true,
      etDate,
      resetFailuresOnly,
      resetEntries: !resetFailuresOnly,
    },
    { status: 200 }
  );
}
