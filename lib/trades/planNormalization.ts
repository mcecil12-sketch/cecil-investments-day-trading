export type TradePlanSide = "LONG" | "SHORT";

export type NormalizeTradePlanInput = {
  side: TradePlanSide;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  rewardMultiple?: number;
};

export type NormalizeTradePlanResult = {
  ok: boolean;
  invalidReason?: string;
  originalEntryPrice: number;
  originalStopPrice: number;
  originalTargetPrice: number;
  normalizedEntryPrice: number;
  normalizedStopPrice: number;
  normalizedTargetPrice: number;
  normalizedForSide: boolean;
  rewardMultipleUsed: number;
};

const DEFAULT_REWARD_MULTIPLE = 2;

function toNum(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export function isTradePlanSideValid(
  side: TradePlanSide,
  entryPrice: number,
  stopPrice: number,
  targetPrice: number,
): boolean {
  if (!(entryPrice > 0 && stopPrice > 0 && targetPrice > 0)) return false;
  if (side === "LONG") {
    return stopPrice < entryPrice && targetPrice > entryPrice;
  }
  return stopPrice > entryPrice && targetPrice < entryPrice;
}

export function normalizeTradePlanForSide(input: NormalizeTradePlanInput): NormalizeTradePlanResult {
  const side = input.side;
  const entry = toNum(input.entryPrice);
  const stop = toNum(input.stopPrice);
  const target = toNum(input.targetPrice);

  const bad = (reason: string): NormalizeTradePlanResult => ({
    ok: false,
    invalidReason: reason,
    originalEntryPrice: entry,
    originalStopPrice: stop,
    originalTargetPrice: target,
    normalizedEntryPrice: entry,
    normalizedStopPrice: stop,
    normalizedTargetPrice: target,
    normalizedForSide: false,
    rewardMultipleUsed: Number.isFinite(input.rewardMultiple as number)
      ? Number(input.rewardMultiple)
      : DEFAULT_REWARD_MULTIPLE,
  });

  if (!(side === "LONG" || side === "SHORT")) return bad("invalid_side");
  if (!(entry > 0 && stop > 0 && target > 0)) return bad("missing_or_non_positive_prices");

  if (isTradePlanSideValid(side, entry, stop, target)) {
    const risk = Math.abs(entry - stop);
    const reward = Math.abs(target - entry);
    const inferredR = risk > 0 ? reward / risk : DEFAULT_REWARD_MULTIPLE;
    return {
      ok: true,
      originalEntryPrice: entry,
      originalStopPrice: stop,
      originalTargetPrice: target,
      normalizedEntryPrice: entry,
      normalizedStopPrice: stop,
      normalizedTargetPrice: target,
      normalizedForSide: false,
      rewardMultipleUsed: Number.isFinite(inferredR) && inferredR > 0 ? inferredR : DEFAULT_REWARD_MULTIPLE,
    };
  }

  // Invert long-style bracket to short, preserving risk distance and R multiple.
  if (side === "SHORT" && stop < entry && target > entry) {
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) return bad("invalid_risk_distance");

    const reward = Math.abs(target - entry);
    const inferredR = reward > 0 && Number.isFinite(reward / risk)
      ? reward / risk
      : Number.isFinite(input.rewardMultiple as number) && Number(input.rewardMultiple) > 0
        ? Number(input.rewardMultiple)
        : DEFAULT_REWARD_MULTIPLE;

    const normalizedStop = Number((entry + risk).toFixed(6));
    const normalizedTarget = Number((entry - risk * inferredR).toFixed(6));

    if (!isTradePlanSideValid("SHORT", entry, normalizedStop, normalizedTarget)) {
      return bad("normalization_failed_short_inversion");
    }

    return {
      ok: true,
      originalEntryPrice: entry,
      originalStopPrice: stop,
      originalTargetPrice: target,
      normalizedEntryPrice: entry,
      normalizedStopPrice: normalizedStop,
      normalizedTargetPrice: normalizedTarget,
      normalizedForSide: true,
      rewardMultipleUsed: inferredR,
    };
  }

  return bad("invalid_trade_plan_for_side");
}
