import { NextResponse } from "next/server";
import { getAutoConfig } from "@/lib/autoEntry/config";
import { alpacaRequest } from "@/lib/alpaca";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

function headerToken(req: Request) {
  return req.headers.get("x-auto-entry-token") || "";
}

async function ensureToken(req: Request) {
  const cfg = getAutoConfig();

  const cookieOk = await requireAuth(req);
  if (cookieOk.ok) return { ok: true as const };

  if (!cfg.token) return { ok: false as const, status: 500, error: "AUTO_ENTRY_TOKEN missing" };
  const got = headerToken(req);
  if (!got || got !== cfg.token) return { ok: false as const, status: 401, error: "unauthorized" };
  return { ok: true as const };
}

export async function GET(req: Request) {
  return POST(req);
}

export async function POST(req: Request) {
  const auth = await ensureToken(req);
  if (!auth.ok) return NextResponse.json(auth, { status: auth.status });

  const url = new URL(req.url);
  const qsSymbol = url.searchParams.get("symbol") || url.searchParams.get("ticker") || "";
  const body = await req.json().catch(() => ({}));
  const symbol = String(qsSymbol || body?.symbol || body?.ticker || "").toUpperCase();
  const qs = symbol
    ? `status=open&symbols=${encodeURIComponent(symbol)}&limit=50`
    : "status=open&limit=50";

  const resp = await alpacaRequest({ method: "GET", path: `/v2/orders?${qs}` });
  if (!resp.ok) {
    return NextResponse.json(
      { ok: false, status: resp.status, error: resp.text || "alpaca error" },
      { status: 500 }
    );
  }

  let orders: any[] = [];
  try {
    const parsed = JSON.parse(resp.text || "[]");
    orders = Array.isArray(parsed) ? parsed : [];
  } catch {
    orders = [];
  }

  return NextResponse.json(
    { ok: true, count: orders.length, orders },
    { status: 200 }
  );
}
