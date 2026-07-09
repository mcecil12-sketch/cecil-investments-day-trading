import { normalizeStopPrice, normalizeLimitPrice, tickForEquityPrice } from "@/lib/tickSize";

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function minTick(n: number, tick = 0.01) {
  return round2(Math.round(n / tick) * tick);
}

function ensureMinDistanceFromBase(params: {
  side: Side;
  basePrice: number;
  takeProfitPrice: number;
  stopPrice: number;
  minOffset: number;
}) {
  const { side, basePrice, minOffset } = params;
  let tp = params.takeProfitPrice;
  let sl = params.stopPrice;

  if (side === "LONG") {
    if (!(tp >= basePrice + minOffset)) tp = basePrice + minOffset;
    if (!(sl <= basePrice - minOffset)) sl = basePrice - minOffset;
  } else {
    if (!(tp <= basePrice - minOffset)) tp = basePrice - minOffset;
    if (!(sl >= basePrice + minOffset)) sl = basePrice + minOffset;
  }

  return { takeProfitPrice: tp, stopPrice: sl };
}

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

function clampBracketPrices(opts: {
  side: Side;
  basePrice: number;
  takeProfitPrice: number;
  stopPrice: number;
  tick?: number;
}) {
  const tick = opts.tick ?? 0.01;
  const base = opts.basePrice;

  let tp = minTick(opts.takeProfitPrice, tick);
  let st = minTick(opts.stopPrice, tick);

  if (opts.side === "LONG") {
    const minTp = minTick(base + tick, tick);
    const maxStop = minTick(base - tick, tick);
    if (!(tp >= minTp)) tp = minTp;
    if (!(st <= maxStop)) st = maxStop;
  } else {
    const maxTp = minTick(base - tick, tick);
    const minStop = minTick(base + tick, tick);
    if (!(tp <= maxTp)) tp = maxTp;
    if (!(st >= minStop)) st = minStop;
  }

  return { takeProfitPrice: tp, stopPrice: st };
}

export function computeBracket({
  side,
  decisionPrice,
  stopDistance,
  rr,
}: {
  side: Side;
  decisionPrice: number;
  stopDistance: number;
  rr: number;
}) {
  if (!(decisionPrice > 0)) throw new Error("decisionPrice must be > 0");
  if (!(stopDistance > 0)) throw new Error("stopDistance must be > 0");
  if (!(rr > 0)) throw new Error("rr must be > 0");

  const entryPrice = round2(decisionPrice);
  const normalizedStopDistance = round2(stopDistance);

  let stopPrice =
    side === "LONG"
      ? round2(entryPrice - normalizedStopDistance)
      : round2(entryPrice + normalizedStopDistance);

  let takeProfitPrice =
    side === "LONG"
      ? round2(entryPrice + normalizedStopDistance * rr)
      : round2(entryPrice - normalizedStopDistance * rr);

  const minOffsetGuard = ensureMinDistanceFromBase({
    side,
    basePrice: entryPrice,
    takeProfitPrice,
    stopPrice,
    minOffset: 0.01,
  });
  takeProfitPrice = minOffsetGuard.takeProfitPrice;
  stopPrice = minOffsetGuard.stopPrice;

  const clamped = clampBracketPrices({
    side,
    basePrice: entryPrice,
    takeProfitPrice,
    stopPrice,
  });
  takeProfitPrice = clamped.takeProfitPrice;
  stopPrice = clamped.stopPrice;

  // FINAL normalization pass using tickSize utilities
  const tick = tickForEquityPrice(entryPrice);
  const stopNorm = normalizeStopPrice({
    side,
    entryPrice,
    stopPrice,
    tick,
  });
  if (stopNorm.ok) {
    stopPrice = stopNorm.stop;
  }

  const tpNorm = normalizeLimitPrice({
    price: takeProfitPrice,
    tick,
  });
  takeProfitPrice = tpNorm;

  return { entryPrice, stopPrice, takeProfitPrice };
}

function num(v: any): number | null {
  const n = typeof v === "number" ? v : v == null ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
}
