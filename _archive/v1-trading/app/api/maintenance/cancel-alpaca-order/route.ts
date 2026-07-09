import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { alpacaRequest } from "@/lib/alpaca";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await requireAuth(req);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { orderId?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {}

  const orderId = String(body.orderId || "").trim();
  if (!orderId) {
    return NextResponse.json({ ok: false, error: "missing_orderId" }, { status: 400 });
  }

  const resp = await alpacaRequest({ method: "DELETE", path: `/v2/orders/${encodeURIComponent(orderId)}` });
  if (resp.ok || resp.status === 404) {
    return NextResponse.json({ ok: true, orderId }, { status: 200 });
  }

  return NextResponse.json(
    { ok: false, status: resp.status, text: resp.text || "delete_failed" },
    { status: resp.status }
  );
}
