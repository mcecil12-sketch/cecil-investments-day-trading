import { describe, expect, it } from "vitest";
import {
  isScoreBelowAdjustedThreshold,
  resolveThresholdDiagnostics,
} from "@/lib/autoEntry/executionThresholds";

describe("resolveThresholdDiagnostics", () => {
  it("trusts seeded tier C and allows score 6.65 with no score adjustments", () => {
    const diag = resolveThresholdDiagnostics({
      trade: { aiScore: 6.65, tier: "C", aiGrade: "B" },
      allowedGrades: ["A", "B", "C"],
      overlayMinScoreAdjustment: 0,
      adaptiveMinScoreAdjustment: 0,
      thresholdConfig: { tierAmin: 8.5, tierBmin: 7.5, tierCmin: 6.5 },
      inferTierForScore: () => "B",
    });

    expect(diag.tier).toBe("C");
    expect(diag.thresholdSource).toBe("seeded_tier");
    expect(diag.baseTierThreshold).toBe(6.5);
    expect(diag.adjustedThreshold).toBe(6.5);
    expect(isScoreBelowAdjustedThreshold(diag)).toBe(false);
  });

  it("applies overlay/adaptive adjustments transparently", () => {
    const diag = resolveThresholdDiagnostics({
      trade: { aiScore: 6.65, tier: "C" },
      allowedGrades: ["A", "B", "C"],
      overlayMinScoreAdjustment: 0.5,
      adaptiveMinScoreAdjustment: 0.5,
      thresholdConfig: { tierAmin: 8.5, tierBmin: 7.5, tierCmin: 6.5 },
      inferTierForScore: () => "C",
    });

    expect(diag.adjustedThreshold).toBe(7.5);
    expect(isScoreBelowAdjustedThreshold(diag)).toBe(true);
  });

  it("ignores overlay and adaptive adjustments at execute time", () => {
    const diag = resolveThresholdDiagnostics({
      trade: { aiScore: 6.6, tier: "C" },
      allowedGrades: ["A", "B", "C"],
      overlayMinScoreAdjustment: 0.5,
      adaptiveMinScoreAdjustment: 0.5,
      honorSeedDecisionAtExecute: true,
      thresholdConfig: { tierAmin: 8.5, tierBmin: 7.5, tierCmin: 6.5 },
      inferTierForScore: () => "B",
    });

    expect(diag.tier).toBe("C");
    expect(diag.baseTierThreshold).toBe(6.5);
    expect(diag.overlayMinScoreAdjustment).toBe(0.5);
    expect(diag.overlayMinScoreAdjustmentIgnoredAtExecute).toBe(true);
    expect(diag.adaptiveMinScoreAdjustment).toBe(0.5);
    expect(diag.adaptiveMinScoreAdjustmentIgnoredAtExecute).toBe(true);
    expect(diag.adjustedThreshold).toBe(6.5);
    expect(diag.thresholdSource).toBe("seed_decision_honored");
    expect(isScoreBelowAdjustedThreshold(diag)).toBe(false);
  });
});
