// lib/risk.ts

export function computeRiskPerShare(
  entryPrice: number,
  stopPrice?: number | null
): number {
  if (stopPrice == null) return 0;
  return Math.abs(entryPrice - stopPrice);
}

export function computeDollarRisk(
  entryPrice: number,
  stopPrice: number | undefined,
  size: number
): number {
  const rps = computeRiskPerShare(entryPrice, stopPrice);
  return rps * size;
}

export function sideSign(side: "LONG" | "SHORT"): 1 | -1 {
  return side === "LONG" ? 1 : -1;
}

/**
 * Compute current R multiple based on a trade-like object.
 * Positive = in your favor; negative = against you.
 */
export function computeRMultiple(
  trade: {
    side: "LONG" | "SHORT";
    entryPrice: number;
    size: number;
  },
  currentPrice: number,
  oneR: number
): number | null {
  if (!oneR || !trade.size) return null;
  const sgn = sideSign(trade.side);
  const pnlDollars = (currentPrice - trade.entryPrice) * sgn * trade.size;
  return pnlDollars / oneR;
}

/**
 * Derive a price target at a given R multiple.
 * Useful for: "2R target ≈ $X".
 */
export function deriveTargetPrice(
  entryPrice: number,
  side: "LONG" | "SHORT",
  rMultiple: number,
  riskPerShare: number
): number {
  const sgn = side === "LONG" ? 1 : -1;
  const move = rMultiple * riskPerShare * sgn;
  return entryPrice + move;
}
