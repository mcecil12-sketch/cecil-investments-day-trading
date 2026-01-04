import { round, safeDiv, num } from "@/lib/performance/math";
import { bucketET, etParts } from "@/lib/performance/time";

export type ClosedTrade = {
  id?: string;
  ticker?: string;
  side?: string;
  status?: string;

  createdAt?: string;
  openedAt?: string;
  closedAt?: string;
  executedAt?: string;
  updatedAt?: string;

  tier?: "A" | "B" | "C" | "REJECT";
  score?: number;
  grade?: string;

  realizedPnL?: number;
  realizedR?: number;

  entryPrice?: number;
  exitPrice?: number;
  stopPrice?: number;
  quantity?: number;

  source?: string;
};

function isClosed(t: any) {
  const s = String(t?.status || "").toUpperCase();
  return s === "CLOSED" || s === "DONE" || s === "EXITED";
}

function pickCloseTs(t: any): string | null {
  return (
    (typeof t?.closedAt === "string" && t.closedAt) ||
    (typeof t?.exitAt === "string" && t.exitAt) ||
    (typeof t?.updatedAt === "string" && t.updatedAt) ||
    null
  );
}

function normTier(t: any): "A" | "B" | "C" | "REJECT" {
  const raw = String(t?.tier || "").toUpperCase();
  if (raw === "A" || raw === "B" || raw === "C" || raw === "REJECT") return raw as any;
  return "REJECT";
}


function inferScore(t: any): number | null {
  const v =
    t?.score ??
    t?.aiScore ??
    t?.signalScore ??
    t?.ai?.score ??
    t?.ai?.aiScore ??
    t?.signal?.score;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function inferTierFromScore(score: number | null): "A" | "B" | "C" | "REJECT" {
  if (score == null) return "REJECT";
  if (score >= 8.5) return "A";
  if (score >= 7.5) return "B";
  if (score >= 6.5) return "C";
  return "REJECT";
}

function inferTier(t: any): "A" | "B" | "C" | "REJECT" {
  const rawTier = String(t?.tier ?? t?.ai?.tier ?? t?.signalTier ?? "").toUpperCase();
  if (rawTier === "A" || rawTier === "B" || rawTier === "C" || rawTier === "REJECT") return rawTier as any;

  const rawGrade = String(t?.grade ?? t?.ai?.grade ?? t?.signalGrade ?? "").toUpperCase();
  if (rawGrade === "A" || rawGrade === "B" || rawGrade === "C") return rawGrade as any;

  return inferTierFromScore(inferScore(t));
}

function inferGrade(t: any): string | undefined {
  const g = t?.grade ?? t?.ai?.grade ?? t?.signalGrade;
  return typeof g === "string" && g ? g : undefined;
}

export function extractClosedTrades(allTrades: any[]): ClosedTrade[] {
  const src = Array.isArray(allTrades) ? allTrades : [];
  return src
    .filter(isClosed)
    .map((t) => {
      const closedAt = pickCloseTs(t);
      return {
        id: t?.id,
        ticker: t?.ticker,
        side: t?.side,
        status: t?.status,
        createdAt: t?.createdAt,
        openedAt: t?.openedAt ?? t?.executedAt,
        executedAt: t?.executedAt,
        closedAt: closedAt || undefined,
        updatedAt: t?.updatedAt,
        tier: inferTier(t),
        score: inferScore(t) ?? undefined,
        grade: inferGrade(t),
        realizedPnL: num(t?.realizedPnL, null) ?? undefined,
        realizedR: num(t?.realizedR, null) ?? undefined,
        entryPrice: num(t?.entryPrice, null) ?? undefined,
        exitPrice: num(t?.exitPrice, null) ?? undefined,
        stopPrice: num(t?.stopPrice, null) ?? undefined,
        quantity: num(t?.quantity ?? t?.qty, null) ?? undefined,
        source: typeof t?.source === "string" ? t.source : undefined,
      };
    });
}

export type AnalyticsTotals = {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  realizedPnL: number;
  avgPnL: number;
  realizedR: number;
  avgR: number;
};

function emptyTotals(): AnalyticsTotals {
  return { trades: 0, wins: 0, losses: 0, winRate: 0, realizedPnL: 0, avgPnL: 0, realizedR: 0, avgR: 0 };
}

function addTrade(tot: AnalyticsTotals, t: ClosedTrade) {
  const pnl = num(t.realizedPnL, 0) ?? 0;
  const r = num(t.realizedR, 0) ?? 0;
  tot.trades += 1;
  tot.realizedPnL = round(tot.realizedPnL + pnl, 2);
  tot.realizedR = round(tot.realizedR + r, 3);
  if (pnl > 0) tot.wins += 1;
  if (pnl < 0) tot.losses += 1;
}

function finalizeTotals(tot: AnalyticsTotals) {
  tot.winRate = round(safeDiv(tot.wins, tot.trades, 0) * 100, 2);
  tot.avgPnL = round(safeDiv(tot.realizedPnL, tot.trades, 0), 2);
  tot.avgR = round(safeDiv(tot.realizedR, tot.trades, 0), 3);
  return tot;
}

export function buildAnalytics(trades: ClosedTrade[]) {
  const totals = emptyTotals();

  const byTier: Record<string, AnalyticsTotals> = {
    A: emptyTotals(),
    B: emptyTotals(),
    C: emptyTotals(),
    REJECT: emptyTotals(),
  };

  const byBucket: Record<string, AnalyticsTotals> = {
    open: emptyTotals(),
    mid: emptyTotals(),
    power: emptyTotals(),
    after: emptyTotals(),
  };

  for (const t of trades) {
    addTrade(totals, t);
    addTrade(byTier[t.tier || "REJECT"] || byTier.REJECT, t);

    const ts = t.closedAt || t.executedAt || t.openedAt || t.createdAt;
    const { hhmm } = etParts(ts || undefined);
    const b = bucketET(hhmm);
    addTrade(byBucket[b], t);
  }

  return {
    totals: finalizeTotals(totals),
    byTier: Object.fromEntries(Object.entries(byTier).map(([k, v]) => [k, finalizeTotals(v)])),
    byBucket: Object.fromEntries(Object.entries(byBucket).map(([k, v]) => [k, finalizeTotals(v)])),
  };
}
