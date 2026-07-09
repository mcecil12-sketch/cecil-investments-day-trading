import { NextResponse } from "next/server";
import { lockTtlSeconds } from "@/lib/locks";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const key = searchParams.get("key") || "";
  if (!key) return NextResponse.json({ ok: false, error: "missing key" }, { status: 400 });

  const out = await lockTtlSeconds(key);
  return NextResponse.json({ ok: true, ...out });
}
