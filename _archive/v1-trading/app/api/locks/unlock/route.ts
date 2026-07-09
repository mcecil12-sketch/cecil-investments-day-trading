import { NextResponse } from "next/server";
import { unlockLockKey } from "@/lib/locks";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await requireAuth(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  if (process.env.LOCK_DEBUG_ENABLED !== "1") {
    return NextResponse.json({ ok: false, error: "disabled" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const key = String(body?.key || "");
  if (!key) return NextResponse.json({ ok: false, error: "missing key" }, { status: 400 });

  const out = await unlockLockKey(`lock:${key}`);
  return NextResponse.json({ ok: true, ...out });
}
