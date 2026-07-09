import { NextResponse } from "next/server";
import { alpacaRequest } from "@/lib/alpaca";
import { recordEquityPoint } from "@/lib/performance/equityRedis";
import { etParts } from "@/lib/performance/time";

export const dynamic = "force-dynamic";

async function getAccountSafe() {
  const r = await alpacaRequest({ method: "GET", path: "/v2/account" });
  if (!r.ok) return null;
  try {
    return JSON.parse(r.text || "null");
  } catch {
    return null;
  }
}

async function getPositionsSafe() {
  const r = await alpacaRequest({ method: "GET", path: "/v2/positions" });
  if (!r.ok) return [];
  try {
    const j = JSON.parse(r.text || "[]");
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

export async function POST(req: Request) {
  const token = req.headers.get("x-cron-token") || "";
  if (!process.env.CRON_TOKEN || token !== process.env.CRON_TOKEN) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const runId = req.headers.get("x-run-id") || "";
  const source = req.headers.get("x-run-source") || "snapshot";

  const account = await getAccountSafe();
  const positions = await getPositionsSafe();

  const ts = new Date().toISOString();
  const parts = etParts(ts);

  const equity = Number(account?.equity ?? 0) || 0;
  const cash = Number(account?.cash ?? 0) || 0;
  const buyingPower = Number(account?.buying_power ?? 0) || 0;

  const unrealizedPnL = positions.reduce((acc: number, p: any) => {
    const u = Number(p?.unrealized_pl ?? 0) || 0;
    return acc + u;
  }, 0);

  const res = await recordEquityPoint({
    ts,
    dateET: parts.dateET,
    hhmm: parts.hhmm,
    equity,
    cash,
    buyingPower,
    unrealizedPnL,
    positionsCount: positions.length,
    source,
    runId,
  });

  return NextResponse.json({
    ok: true,
    stored: (res as any).stored,
    redis: (res as any).redis,
    point: (res as any).point || {
      ts,
      dateET: parts.dateET,
      hhmm: parts.hhmm,
      equity,
      cash,
      buyingPower,
      unrealizedPnL,
      positionsCount: positions.length,
      source,
      runId,
    },
  });
}
