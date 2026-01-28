export type QuantizeMode = "round" | "floor" | "ceil";
export type Side = "LONG" | "SHORT";

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

export function tickForEquityPrice(price: number): number {
  if (!isFiniteNumber(price)) return 0.01;
  return price < 1 ? 0.0001 : 0.01;
}

export function quantizePrice(price: number, tick = 0.01, mode: QuantizeMode = "round"): number {
  if (!isFiniteNumber(price) || !isFiniteNumber(tick) || tick <= 0) return NaN;

  const inv = Math.round(1 / tick);
  if (!Number.isFinite(inv) || inv <= 0) return NaN;

  const scaled = price * inv;

  let k: number;
  if (mode === "floor") k = Math.floor(scaled + 1e-12);
  else if (mode === "ceil") k = Math.ceil(scaled - 1e-12);
  else k = Math.round(scaled);

  const out = k / inv;

  return Number.isFinite(out) ? out : NaN;
}

export function ensureMinTick(price: number, tick = 0.01): number {
  return quantizePrice(price, tick, "round");
}

export function validateStopDirectional(args: {
  side: Side;
  entryPrice: number;
  stopPrice: number;
}): { ok: true } | { ok: false; reason: string } {
  const { side, entryPrice, stopPrice } = args;
  if (!Number.isFinite(entryPrice) || !Number.isFinite(stopPrice)) return { ok: false, reason: "non_finite_price" };

  if (side === "LONG") {
    if (!(stopPrice < entryPrice)) return { ok: false, reason: "stop_not_below_entry_for_long" };
  } else {
    if (!(stopPrice > entryPrice)) return { ok: false, reason: "stop_not_above_entry_for_short" };
  }
  return { ok: true };
}

export function normalizeStopPrice(args: {
  side: Side;
  entryPrice: number;
  stopPrice: number;
  tick?: number;
}): { ok: true; stop: number } | { ok: false; reason: string; stop?: number } {
  const tick = Number.isFinite(args.tick) && (args.tick as number) > 0 ? (args.tick as number) : tickForEquityPrice(args.entryPrice);

  const mode: QuantizeMode = args.side === "LONG" ? "floor" : "ceil";
  const q = quantizePrice(args.stopPrice, tick, mode);
  if (!Number.isFinite(q)) return { ok: false, reason: "stop_quantize_failed" };

  const dir = validateStopDirectional({ side: args.side, entryPrice: args.entryPrice, stopPrice: q });
  if (!dir.ok) return { ok: false, reason: dir.reason, stop: q };

  return { ok: true, stop: q };
}

export function normalizeLimitPrice(args: {
  price: number;
  tick?: number;
}): number {
  const tick = Number.isFinite(args.tick) && (args.tick as number) > 0 ? (args.tick as number) : tickForEquityPrice(args.price);
  const q = quantizePrice(args.price, tick, "round");
  return Number.isFinite(q) ? q : args.price;
}
