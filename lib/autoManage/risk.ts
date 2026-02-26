export type ComputeUnrealizedRArgs = {
  side: string;
  qty?: number | null | undefined;
  entryPrice: number | null | undefined;
  stopPrice: number | null | undefined;
  currentPrice: number | null | undefined;
  clampAbs?: number;
  onInvalid?: (reason: string) => void;
};

const num = (v: any) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function computeUnrealizedR(args: ComputeUnrealizedRArgs): number | null {
  const side = String(args.side || "").toUpperCase();
  const qty = num(args.qty);
  const entry = num(args.entryPrice);
  const stop = num(args.stopPrice);
  const current = num(args.currentPrice);

  if (side !== "LONG" && side !== "SHORT") {
    args.onInvalid?.("invalid_side");
    return null;
  }

  if (qty == null || qty <= 0) {
    args.onInvalid?.("missing_qty");
    return null;
  }

  if (entry == null || entry <= 0) {
    args.onInvalid?.("missing_entry");
    return null;
  }

  if (stop == null || stop <= 0) {
    args.onInvalid?.("missing_stop");
    return null;
  }

  if (current == null || current <= 0) {
    args.onInvalid?.("missing_price");
    return null;
  }

  const riskPerShare =
    side === "SHORT" ? (stop - entry) : (entry - stop);

  if (!Number.isFinite(riskPerShare) || riskPerShare <= 0) {
    args.onInvalid?.("invalid_risk_per_share");
    return null;
  }

  const raw =
    side === "SHORT"
      ? (entry - current) / riskPerShare
      : (current - entry) / riskPerShare;

  if (!Number.isFinite(raw)) {
    args.onInvalid?.("invalid_r_value");
    return null;
  }

  if (args.clampAbs && args.clampAbs > 0 && Math.abs(raw) > args.clampAbs) {
    args.onInvalid?.("r_clamped_absurd");
    return Math.max(-args.clampAbs, Math.min(args.clampAbs, raw));
  }

  return raw;
}

export type ReplacementDecisionArgs = {
  openUnrealizedR: number | null | undefined;
  openScore: number | null | undefined;
  candidateScore: number | null | undefined;
  allowUnknownROverride: boolean;
  overrideScoreDelta: number;
};

export type ReplacementDecision = {
  execute: boolean;
  reason:
    | "replace_execute"
    | "replace_skip_r_positive"
    | "replace_skip_delta_too_small"
    | "replace_skip_r_unknown"
    | "replace_skip_no_candidates";
  scoreDelta: number | null;
};

export function decideReplacement(args: ReplacementDecisionArgs): ReplacementDecision {
  const openR = num(args.openUnrealizedR);
  const openScore = num(args.openScore);
  const candidateScore = num(args.candidateScore);

  if (candidateScore == null) {
    return {
      execute: false,
      reason: "replace_skip_no_candidates",
      scoreDelta: null,
    };
  }

  const scoreDelta =
    openScore != null && candidateScore != null ? candidateScore - openScore : null;
  const minDelta = Math.max(0, Number(args.overrideScoreDelta) || 0);

  if (openR == null) {
    if (!args.allowUnknownROverride) {
      return {
        execute: false,
        reason: "replace_skip_r_unknown",
        scoreDelta,
      };
    }
    if (scoreDelta == null || scoreDelta < minDelta) {
      return {
        execute: false,
        reason: "replace_skip_delta_too_small",
        scoreDelta,
      };
    }
    return {
      execute: true,
      reason: "replace_execute",
      scoreDelta,
    };
  }

  if (openR > 0) {
    return {
      execute: false,
      reason: "replace_skip_r_positive",
      scoreDelta,
    };
  }

  if (scoreDelta == null || scoreDelta < minDelta) {
    return {
      execute: false,
      reason: "replace_skip_delta_too_small",
      scoreDelta,
    };
  }

  return {
    execute: true,
    reason: "replace_execute",
    scoreDelta,
  };
}
