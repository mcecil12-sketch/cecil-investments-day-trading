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

function isOpen(status: any) {
  return String(status || "").toUpperCase() === "OPEN";
}

export function decideCutLossAction(args: {
  enabled: boolean;
  thresholdR: number;
  trade: CutLossTradeLike;
}): CutLossAction | null {
  const { enabled, thresholdR, trade } = args;
  if (!enabled) return null;
  if (!trade || !isOpen(trade.status)) return null;

  const r = Number(trade.unrealizedR);
  if (!Number.isFinite(r)) return null;
  if (r > thresholdR) return null;

  return {
    tradeId: String(trade.id),
    ticker: String(trade.ticker || "").toUpperCase(),
    reason: "cut_loss_r",
    rule: "CUT_LOSS_R",
    r,
  };
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
