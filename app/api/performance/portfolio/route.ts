import { NextResponse } from "next/server";
import { readTrades } from "@/lib/tradesStore";

export const dynamic = "force-dynamic";

const STARTING_BALANCE = Number(process.env.STARTING_BALANCE || "100000");

function dayKey(iso: string) {
  return iso.slice(0, 10);
}

export async function GET() {
  const trades = await readTrades();

  const closed = (trades || [])
    .filter((t: any) => t?.status === "CLOSED" && typeof t?.realizedPnL === "number" && t?.closedAt)
    .sort((a: any, b: any) => +new Date(a.closedAt) - +new Date(b.closedAt));

  let equity = STARTING_BALANCE;

  const dailyPnLMap = new Map<string, number>();
  const equityCurve: { date: string; equity: number }[] = [];

  for (const t of closed) {
    const d = dayKey(t.closedAt);
    const pnl = Number(t.realizedPnL || 0);
    equity += pnl;
    dailyPnLMap.set(d, (dailyPnLMap.get(d) || 0) + pnl);
    equityCurve.push({ date: d, equity });
  }

  const dailyPnL = Array.from(dailyPnLMap.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, pnl]) => ({ date, pnl }));

  const wins = closed.filter((t: any) => Number(t.realizedPnL) > 0);
  const losses = closed.filter((t: any) => Number(t.realizedPnL) < 0);

  const totalPnL = equity - STARTING_BALANCE;

  return NextResponse.json({
    ok: true,
    startingBalance: STARTING_BALANCE,
    currentBalance: equity,
    totalPnL,
    equityCurve,
    dailyPnL,
    tradeStats: {
      totalClosedTrades: closed.length,
      winRate: closed.length ? wins.length / closed.length : 0,
      avgWin: wins.length
        ? wins.reduce((s: number, t: any) => s + Number(t.realizedPnL), 0) / wins.length
        : 0,
      avgLoss: losses.length
        ? losses.reduce((s: number, t: any) => s + Number(t.realizedPnL), 0) / losses.length
        : 0,
    },
  });
}
