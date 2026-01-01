import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { clearNotificationDedupe } from "@/lib/notifications/dedupe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { dedupeKey?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {}

  if (!body.dedupeKey) {
    return NextResponse.json({ ok: false, error: "missing_dedupeKey" }, { status: 400 });
  }

  await clearNotificationDedupe(body.dedupeKey);
  return NextResponse.json({ ok: true }, { status: 200 });
}
