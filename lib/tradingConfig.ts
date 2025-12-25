export type TradingTier = "A" | "B" | "C" | "REJECT";
export type TradingConfig = {
  mode: "PAPER" | "LIVE";
  tiers: {
    A: { minScore: number; riskMult: number };
    B: { minScore: number; riskMult: number };
    C: { minScore: number; riskMult: number };
    rejectBelow: number;
  };
  limits: {
    maxOpenPositions: number;
    maxNewEntriesPerDay: number;
    cooldownMinutesAfterLoss: number;
  };
  risk: {
    baseTradeRiskPct: number;
    dailyRiskBudgetPct: number;
    allowTierDowngrade: boolean;
  };
  liquidity: {
    windowMinutes: number;
    hardReject: {
      minAvgVolShares: number;
      maxSpreadPct: number;
    };
    soft: {
      refMinAvgDollarVol: number;
      cTierMinAvgDollarVol: number;
    };
    spread: {
      maxPct: number;
      cTierMaxPct: number;
    };
    slippage: {
      blockTrades: boolean;
      maxExpectedSlippagePct: number | null;
      cTierMaxSlippagePct: number | null;
    };
  };
  lifecycle: {
    intradayOnly: boolean;
    flattenByET: string;
    lastEntryTimeET: string;
  };
  flags: {
    autoEntryEnabled: boolean;
    autoManageEnabled: boolean;
    allowShorts: boolean;
    allowTierCAutoEntry: boolean;
    paperTradingOnly: boolean;
    cTierExtraLiquidityGuard: boolean;
  };
};
function num(name: string, fallback: number) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function bool(name: string, fallback: boolean) {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}
function str(name: string, fallback: string) {
  const v = process.env[name];
  return v == null || v === "" ? fallback : v;
}
export function getTradingConfig(): TradingConfig {
  const mode = (str("TRADING_MODE", "PAPER").toUpperCase() === "LIVE" ? "LIVE" : "PAPER") as "PAPER" | "LIVE";
  return {
    mode,
    tiers: {
      A: { minScore: num("TIER_A_MIN", 8.5), riskMult: num("RISK_MULT_A", 2.0) },
      B: { minScore: num("TIER_B_MIN", 7.5), riskMult: num("RISK_MULT_B", 1.5) },
      C: { minScore: num("TIER_C_MIN", 6.5), riskMult: num("RISK_MULT_C", 1.0) },
      rejectBelow: num("TIER_REJECT_BELOW", 6.5),
    },
    limits: {
      maxOpenPositions: num("MAX_OPEN_POSITIONS", 3),
      maxNewEntriesPerDay: num("MAX_NEW_ENTRIES_PER_DAY", 5),
      cooldownMinutesAfterLoss: num("COOLDOWN_MINUTES_AFTER_LOSS", 20),
    },
    risk: {
      baseTradeRiskPct: num("BASE_TRADE_RISK_PCT", 0.2),
      dailyRiskBudgetPct: num("DAILY_RISK_BUDGET_PCT", 1.0),
      allowTierDowngrade: bool("ALLOW_TIER_DOWNGRADE", true),
    },
    liquidity: {
      windowMinutes: num("LIQ_WINDOW_MINUTES", 30),
      hardReject: {
        minAvgVolShares: num("MIN_AVG_VOL_SHARES", 8000),
        maxSpreadPct: num("MAX_SPREAD_PCT", 0.6),
      },
      soft: {
        refMinAvgDollarVol: num("REF_MIN_AVG_DOLLAR_VOL", 250000),
        cTierMinAvgDollarVol: num("C_TIER_MIN_AVG_DOLLAR_VOL", 500000),
      },
      spread: {
        maxPct: num("MAX_SPREAD_PCT", 0.6),
        cTierMaxPct: num("C_TIER_MAX_SPREAD_PCT", 0.4),
      },
      slippage: {
        blockTrades: bool("SLIPPAGE_BLOCK_TRADES", false),
        maxExpectedSlippagePct: process.env.MAX_EXPECTED_SLIPPAGE_PCT ? num("MAX_EXPECTED_SLIPPAGE_PCT", 0.0) : null,
        cTierMaxSlippagePct: process.env.C_TIER_MAX_SLIPPAGE_PCT ? num("C_TIER_MAX_SLIPPAGE_PCT", 0.0) : null,
      },
    },
    lifecycle: {
      intradayOnly: bool("INTRADAY_ONLY", true),
      flattenByET: str("FLATTEN_BY_ET", "15:55"),
      lastEntryTimeET: str("LAST_ENTRY_TIME_ET", "15:30"),
    },
    flags: {
      autoEntryEnabled: bool("AUTO_ENTRY_ENABLED", true),
      autoManageEnabled: bool("AUTO_MANAGE_ENABLED", true),
      allowShorts: bool("ALLOW_SHORTS", true),
      allowTierCAutoEntry: bool("ALLOW_TIER_C_AUTO_ENTRY", true),
      paperTradingOnly: bool("PAPER_TRADING_ONLY", true),
      cTierExtraLiquidityGuard: bool("C_TIER_EXTRA_LIQUIDITY_GUARD", true),
    },
  };
}
export function tierForScore(score: number): TradingTier {
  const c = getTradingConfig();
  if (!Number.isFinite(score)) return "REJECT";
  if (score < c.tiers.rejectBelow) return "REJECT";
  if (score >= c.tiers.A.minScore) return "A";
  if (score >= c.tiers.B.minScore) return "B";
  if (score >= c.tiers.C.minScore) return "C";
  return "REJECT";
}
