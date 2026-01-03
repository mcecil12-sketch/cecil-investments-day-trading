import { NextResponse } from "next/server";
import { readTrades } from "@/lib/tradesStore";
import { alpacaRequest } from "@/lib/alpaca";

export const dynamic = "force-dynamic";

type TradeStatus = "OPEN" | "CLOSED" | "PENDING" | "PARTIAL" | string;

type Trade = {
  id: string;
  ticker: string;
  side: "LONG" | "SHORT" | string;
  status: TradeStatus;
  createdAt?: string;
  openedAt?: string;
  executedAt?: string;
  closedAt?: string;
  updatedAt?: string;
  quantity?: number;
  qty?: number;
  entryPrice?: number;
  realizedPnL?: number | null;
};

type EquityPoint = { t: string; equity: number };
type DailyPoint = { date: string; pnl: number };

function toNum(v: any): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function isoDay(iso: string): string {
  const d = new Date(iso);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function computeMaxDrawdownFromEquity(points: EquityPoint[]): number {
  let peak = -Infinity;
  let maxDd = 0;
  for (const p of points) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak - p.equity;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

async function fetchUnrealizedPnLFromPositions(): Promise<{ unrealizedPnL: number; positionsCount: number }> {
  try {
    const resp = await alpacaRequest({ method: "GET", path: "/v2/positions" });
    if (!resp.ok) return { unrealizedPnL: 0, positionsCount: 0 };
    const arr = JSON.parse(resp.text || "[]");
    if (!Array.isArray(arr)) return { unrealizedPnL: 0, positionsCount: 0 };
    let total = 0;
    for (const p of arr) {
      const u = toNum(p?.unrealized_pl);
      if (u != null) total += u;
    }
    return { unrealizedPnL: total, positionsCount: arr.length };
  } catch {
    return { unrealizedPnL: 0, positionsCount: 0 };
  }
}

export async function GET() {
  try {
    const startingBalance = 100000;

    const trades = await readTrades<Trade>();

    const closed = trades
      .filter((t) => (t.status || "").toUpperCase() === "CLOSED")
      .filter((t) => typeof t.realizedPnL === "number")
      .slice()
      .sort((a, b) => {
        const ta = new Date(a.closedAt || a.updatedAt || a.createdAt || 0).getTime();
        const tb = new Date(b.closedAt || b.updatedAt || b.createdAt || 0).getTime();
        return ta - tb;
      });

    const realizedPnLTotal = closed.reduce((sum, t) => sum + (typeof t.realizedPnL === "number" ? t.realizedPnL : 0), 0);

    const { unrealizedPnL, positionsCount } = await fetchUnrealizedPnLFromPositions();

    const currentBalance = startingBalance + realizedPnLTotal + unrealizedPnL;
    const totalPnL = currentBalance - startingBalance;

    const equityCurve: EquityPoint[] = [];
    let eq = startingBalance;

    for (const t of closed) {
      const pnl = typeof t.realizedPnL === "number" ? t.realizedPnL : 0;
      eq += pnl;
      const ts = t.closedAt || t.updatedAt || t.createdAt || new Date().toISOString();
      equityCurve.push({ t: ts, equity: eq });
    }

    const nowIso = new Date().toISOString();
    if (equityCurve.length === 0) {
      equityCurve.push({ t: nowIso, equity: currentBalance });
    } else {
      const last = equityCurve[equityCurve.length - 1];
      if (last.t !== nowIso) equityCurve.push({ t: nowIso, equity: currentBalance });
    }

    const dailyMap = new Map<string, number>();
    for (const t of closed) {
      const ts = t.closedAt || t.updatedAt || t.createdAt;
      if (!ts) continue;
      const day = isoDay(ts);
      const pnl = typeof t.realizedPnL === "number" ? t.realizedPnL : 0;
      dailyMap.set(day, (dailyMap.get(day) || 0) + pnl);
    }
    const dailyPnL: DailyPoint[] = Array.from(dailyMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, pnl]) => ({ date, pnl }));

    const closedPnls = closed.map((t) => (typeof t.realizedPnL === "number" ? t.realizedPnL : 0));
    const maxDrawdown = computeMaxDrawdownFromEquity(equityCurve);

    const wins = closedPnls.filter((p) => p > 0);
    const losses = closedPnls.filter((p) => p < 0);

    const tradeStats = {
      totalClosedTrades: closed.length,
      winRate: closed.length ? wins.length / closed.length : 0,
      avgWin: wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0,
      avgLoss: losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0,
    };

    return NextResponse.json(
      {
        ok: true,
        startingBalance,
        currentBalance,
        totalPnL,
        realizedPnL: realizedPnLTotal,
        unrealizedPnL,
        positionsCount,
        equityCurve,
        dailyPnL,
        maxDrawdown,
        tradeStats,
      },
      { status: 200 }
    );
  } catch (err: any) {
    return NextResponse.json(
      {
        ok: false,
        error: "Failed to compute portfolio",
        detail: err?.message ?? String(err),
      },
      { status: 500 }
    );
  }
}
