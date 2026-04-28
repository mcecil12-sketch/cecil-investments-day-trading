export type AllowedTier = "A" | "B" | "C";

export type ThresholdSource =
  | "seeded_tier"
  | "seeded_grade"
  | "score_inferred"
  | "fallback_default";

export type ThresholdDiagnostics = {
  aiScore: number | null;
  tier: AllowedTier;
  baseTierThreshold: number;
  overlayMinScoreAdjustment: number;
  adaptiveMinScoreAdjustment: number;
  adjustedThreshold: number;
  allowedGrades: AllowedTier[];
  thresholdSource: ThresholdSource;
};

type ThresholdConfig = {
  tierAmin?: number;
  tierBmin?: number;
  tierCmin?: number;
};

function normalizeTier(value: unknown): AllowedTier | null {
  const v = String(value || "").trim().toUpperCase();
  if (v === "A" || v === "B" || v === "C") return v;
  return null;
}

function finiteOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function tierBaseThreshold(tier: AllowedTier, config: ThresholdConfig): number {
  if (tier === "A") return finiteOr(config.tierAmin, 8.5);
  if (tier === "B") return finiteOr(config.tierBmin, 7.5);
  return finiteOr(config.tierCmin, 6.5);
}

export function resolveThresholdDiagnostics(params: {
  trade: any;
  allowedGrades: AllowedTier[];
  overlayMinScoreAdjustment: number;
  adaptiveMinScoreAdjustment: number;
  thresholdConfig: ThresholdConfig;
  inferTierForScore: (score: number) => AllowedTier | null;
}): ThresholdDiagnostics {
  const aiScore =
    typeof params.trade?.aiScore === "number" && Number.isFinite(params.trade.aiScore)
      ? params.trade.aiScore
      : null;

  const seededTier = normalizeTier(params.trade?.tier);
  const seededGrade = normalizeTier(params.trade?.aiGrade);

  let tier: AllowedTier = "C";
  let thresholdSource: ThresholdSource = "fallback_default";

  if (seededTier) {
    tier = seededTier;
    thresholdSource = "seeded_tier";
  } else if (seededGrade) {
    tier = seededGrade;
    thresholdSource = "seeded_grade";
  } else if (aiScore != null) {
    tier = params.inferTierForScore(aiScore) ?? "C";
    thresholdSource = "score_inferred";
  }

  const baseTierThreshold = tierBaseThreshold(tier, params.thresholdConfig);
  const overlayMinScoreAdjustment = finiteOr(params.overlayMinScoreAdjustment, 0);
  const adaptiveMinScoreAdjustment = finiteOr(params.adaptiveMinScoreAdjustment, 0);
  const adjustedThreshold = baseTierThreshold + overlayMinScoreAdjustment + adaptiveMinScoreAdjustment;

  return {
    aiScore,
    tier,
    baseTierThreshold,
    overlayMinScoreAdjustment,
    adaptiveMinScoreAdjustment,
    adjustedThreshold,
    allowedGrades: Array.isArray(params.allowedGrades) ? params.allowedGrades : ["A", "B", "C"],
    thresholdSource,
  };
}

export function isScoreBelowAdjustedThreshold(diag: ThresholdDiagnostics): boolean {
  if (diag.aiScore == null) return false;
  return diag.aiScore < diag.adjustedThreshold;
}
