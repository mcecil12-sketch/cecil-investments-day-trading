export type ScorecardWeights = {
  returnOnCapital: number; // 0..1
  winRate: number;         // 0..1
  avgR: number;            // 0..1
  discipline: number;      // 0..1 (guardrails adherence / limits)
};

export type DailyScorecard = {
  ok: true;
  dateET: string; // YYYY-MM-DD
  computedAt: string; // ISO
  weights: ScorecardWeights;

  inputs: {
    startingBalance: number;
    realizedPnL: number;
    trades: number;
    wins: number;
    losses: number;
    winRate: number; // %
    realizedR: number;
    avgR: number;
  };

  metrics: {
    returnOnCapital: number; // realizedPnL / startingBalance
  };

  components: {
    returnOnCapital: number; // 0..100
    winRate: number;         // 0..100
    avgR: number;            // 0..100
    discipline: number;      // 0..100
  };

  totalScore: number; // 0..100
  grade: "A" | "B" | "C" | "D" | "F";
};

