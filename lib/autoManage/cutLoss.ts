export type CutLossTradeLike = {
  id: string;
  ticker: string;
  status?: string;
  unrealizedR?: number | null;
};

export type CutLossAction = {
  tradeId: string;
  ticker: string;
  reason: "cut_loss_r";
  rule: "CUT_LOSS_R";
  r: number;
};

export type CutLossEvaluation = {
  action: CutLossAction | null;
  note?: string;
};

function isOpen(status: any) {
  return String(status || "").toUpperCase() === "OPEN";
}

export function evaluateCutLoss(args: {
  enabled: boolean;
  thresholdR: number;
  trade: CutLossTradeLike;
}): CutLossEvaluation {
  const { enabled, thresholdR, trade } = args;
  const ticker = String(trade?.ticker || "").toUpperCase();

  if (!enabled) {
    return { action: null, note: "cutloss_skip_disabled" };
  }
  if (!trade || !isOpen(trade.status)) {
    return { action: null };
  }

  const rawR = trade?.unrealizedR;
  const r = rawR == null ? NaN : Number(rawR);
  if (!Number.isFinite(r)) {
    return { action: null, note: `cutloss_skip_r_unknown:${ticker}` };
  }
  if (r > thresholdR) {
    return { action: null };
  }

  return {
    action: {
      tradeId: String(trade.id),
      ticker,
      reason: "cut_loss_r",
      rule: "CUT_LOSS_R",
      r,
    },
    note: `cutloss_trigger:${ticker}:r=${r.toFixed(3)}`,
  };
}

export function decideCutLossAction(args: {
  enabled: boolean;
  thresholdR: number;
  trade: CutLossTradeLike;
}): CutLossAction | null {
  return evaluateCutLoss(args).action;
}

export function planCanonicalCutLossActions(args: {
  enabled: boolean;
  thresholdR: number;
  canonicalTrade: CutLossTradeLike;
  duplicates?: CutLossTradeLike[];
}): CutLossAction[] {
  const action = decideCutLossAction({
    enabled: args.enabled,
    thresholdR: args.thresholdR,
    trade: args.canonicalTrade,
  });
  return action ? [action] : [];
}
