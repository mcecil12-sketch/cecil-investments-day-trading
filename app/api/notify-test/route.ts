import { NextResponse } from "next/server";
import { notify } from "@/lib/notify";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let payload: any = {};
  try {
    payload = await req.json();
  } catch {}

  const title = String(payload?.title ?? "Cecil Trading — Notify Test");
  const message = String(
    payload?.message ??
      `If you got this, Pushover is working in production. ${new Date().toISOString()}`
  );

  const result = await notify(title, message);
  return NextResponse.json({ ok: true, result });
}
