export type Side = "LONG" | "SHORT";

export type QuoteLike = {
  last?: number | null;
  mid?: number | null;
  bid?: number | null;
  ask?: number | null;
};

export function resolveDecisionPrice(args: {
  seedEntryPrice?: number | null;
  quote?: QuoteLike | null;
}): { decisionPrice: number; source: "QUOTE_LAST" | "QUOTE_MID" | "SEED" } {
  const seed = num(args.seedEntryPrice);
  const q = args.quote || undefined;

  const last = num(q?.last);
  if (last) return { decisionPrice: last, source: "QUOTE_LAST" };

  const mid = num(q?.mid);
  if (mid) return { decisionPrice: mid, source: "QUOTE_MID" };

  const bid = num(q?.bid);
  const ask = num(q?.ask);
  if (bid && ask) return { decisionPrice: round2((bid + ask) / 2), source: "QUOTE_MID" };

  if (seed) return { decisionPrice: seed, source: "SEED" };

  throw new Error("No usable decision price (no quote + no seed)");
}

export function computeBracket(args: {
  side: Side;
  decisionPrice: number;
  stopDistance: number;
  rr: number;
}): { entryPrice: number; stopPrice: number; takeProfitPrice: number } {
  const { side, decisionPrice, stopDistance, rr } = args;
  if (!(decisionPrice > 0)) throw new Error("decisionPrice must be > 0");
  if (!(stopDistance > 0)) throw new Error("stopDistance must be > 0");
  if (!(rr > 0)) throw new Error("rr must be > 0");

  const entryPrice = round2(decisionPrice);

  const stopPrice =
    side === "LONG"
      ? round2(entryPrice - stopDistance)
      : round2(entryPrice + stopDistance);

  const takeProfitPrice =
    side === "LONG"
      ? round2(entryPrice + stopDistance * rr)
      : round2(entryPrice - stopDistance * rr);

  return { entryPrice, stopPrice, takeProfitPrice };
}

function num(v: any): number | null {
  const n = typeof v === "number" ? v : v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
