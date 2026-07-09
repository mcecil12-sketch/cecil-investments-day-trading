import type { DailyScorecard } from "./types";
import { SCORECARD_WEIGHTS, validateWeights } from "./weights";

function clamp(n: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n));
}

function gradeFor(score: number): DailyScorecard["grade"] {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

// Map ROC (%) into a 0..100 component score.
// -2% or worse => 0
// 0% => 60
// +1% => 80
// +2% => 90
// +3% => 95
// +5% => 100
function scoreReturnOnCapital(roc: number) {
  const pct = roc * 100;
  if (pct <= -2) return 0;
  if (pct >= 5) return 100;
  if (pct === 0) return 60;

  // Piecewise-ish linear ramps around sensible daily/weekly ranges
  if (pct < 0) {
    // -2 -> 0 maps 0 -> 60
    return clamp((pct + 2) * (60 / 2));
  }
  if (pct <= 1) {
    // 0 -> 1 maps 60 -> 80
    return clamp(60 + pct * 20);
  }
  if (pct <= 2) {
    // 1 -> 2 maps 80 -> 90
    return clamp(80 + (pct - 1) * 10);
  }
  if (pct <= 3) {
    // 2 -> 3 maps 90 -> 95
    return clamp(90 + (pct - 2) * 5);
  }
  // 3 -> 5 maps 95 -> 100
  return clamp(95 + ((pct - 3) / 2) * 5);
}

function scoreWinRate(winRatePct: number) {
  // 0% -> 30, 33% -> 60, 50% -> 75, 60% -> 85, 70% -> 92, 80%+ -> 100
  const x = winRatePct;
  if (x <= 0) return 30;
  if (x >= 80) return 100;
  if (x <= 33.33) return clamp(30 + (x / 33.33) * 30);
  if (x <= 50) return clamp(60 + ((x - 33.33) / (50 - 33.33)) * 15);
  if (x <= 60) return clamp(75 + ((x - 50) / 10) * 10);
  if (x <= 70) return clamp(85 + ((x - 60) / 10) * 7);
  return clamp(92 + ((x - 70) / 10) * 8);
}

function scoreAvgR(avgR: number) {
  // -1R -> 10
  // 0R -> 60
  // +0.5R -> 80
  // +1R -> 90
  // +2R+ -> 100
  if (!Number.isFinite(avgR)) return 50;
  if (avgR <= -1) return 10;
  if (avgR >= 2) return 100;
  if (avgR <= 0) {
    // -1 -> 0 maps 10 -> 60
    return clamp(10 + (avgR + 1) * 50);
  }
  if (avgR <= 0.5) {
    // 0 -> .5 maps 60 -> 80
    return clamp(60 + (avgR / 0.5) * 20);
  }
  if (avgR <= 1) {
    // .5 -> 1 maps 80 -> 90
    return clamp(80 + ((avgR - 0.5) / 0.5) * 10);
  }
  // 1 -> 2 maps 90 -> 100
  return clamp(90 + (avgR - 1) * 10);
}

function scoreDiscipline(trades: number) {
  // Placeholder v1: if you traded, assume 85; if no trades, neutral 75.
  // Later we can wire real guardrail events (cooldown tripped, kill switch, max entries hit, etc.)
  if (trades <= 0) return 75;
  return 85;
}

export function computeDailyScorecard(input: {
  dateET: string;
  startingBalance: number;
  realizedPnL: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number; // %
  realizedR: number;
  avgR: number;
}) : DailyScorecard {
  validateWeights(SCORECARD_WEIGHTS);

  const roc =
    input.startingBalance > 0
      ? input.realizedPnL / input.startingBalance
      : 0;

  const components = {
    returnOnCapital: scoreReturnOnCapital(roc),
    winRate: scoreWinRate(input.winRate),
    avgR: scoreAvgR(input.avgR),
    discipline: scoreDiscipline(input.trades),
  };

  const totalScore =
    components.returnOnCapital * SCORECARD_WEIGHTS.returnOnCapital +
    components.winRate * SCORECARD_WEIGHTS.winRate +
    components.avgR * SCORECARD_WEIGHTS.avgR +
    components.discipline * SCORECARD_WEIGHTS.discipline;

  const rounded = Math.round(totalScore * 100) / 100;

  return {
    ok: true,
    dateET: input.dateET,
    computedAt: new Date().toISOString(),
    weights: SCORECARD_WEIGHTS,
    inputs: {
      startingBalance: input.startingBalance,
      realizedPnL: input.realizedPnL,
      trades: input.trades,
      wins: input.wins,
      losses: input.losses,
      winRate: input.winRate,
      realizedR: input.realizedR,
      avgR: input.avgR,
    },
    metrics: {
      returnOnCapital: roc,
    },
    components,
    totalScore: rounded,
    grade: gradeFor(rounded),
  };
}

