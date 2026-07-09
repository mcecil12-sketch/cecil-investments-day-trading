import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { setAutoEntryEnabled } from "@/lib/autoEntry/guardrailsStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { enabled?: boolean; reason?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {}

  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ ok: false, error: "missing_enabled" }, { status: 400 });
  }

  const reason = String(body.reason ?? "manual").trim() || "manual";
  await setAutoEntryEnabled(body.enabled, reason);

  return NextResponse.json({ ok: true, enabled: body.enabled, reason }, { status: 200 });
}
