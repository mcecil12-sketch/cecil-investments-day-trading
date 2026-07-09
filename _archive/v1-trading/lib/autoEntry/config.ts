
export type AutoTier = "A" | "B" | "C";

export function autoEnvBool(key: string, fallback: boolean) {
  const v = process.env[key];
  if (!v) return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export function autoEnvNum(key: string, fallback: number) {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function autoEnvStr(key: string, fallback: string) {
  const v = process.env[key];
  return v ?? fallback;
}

export function getAutoConfig() {
  const enabled = autoEnvBool("AUTO_TRADING_ENABLED", false);
  const paperOnly = autoEnvBool("AUTO_TRADING_PAPER_ONLY", true);

  const allowedTiersRaw = autoEnvStr("AUTO_ALLOWED_TIERS", "A,B,C");
  const allowedTiers = allowedTiersRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((t): t is AutoTier => t === "A" || t === "B" || t === "C");

  const tierAmin = autoEnvNum("AUTO_TIER_A_MIN", 8.0);
  const tierBmin = autoEnvNum("AUTO_TIER_B_MIN", 7.0);
  const tierCmin = autoEnvNum("AUTO_TIER_C_MIN", 6.0);

  const maxOpen = autoEnvNum("AUTO_ENTRY_MAX_OPEN", 3);
  const maxPerDay = autoEnvNum("AUTO_ENTRY_MAX_PER_DAY", 5);
  const cooldownMin = autoEnvNum("AUTO_ENTRY_COOLDOWN_MIN", 20);
  const cutoffMinutesToClose = autoEnvNum("AUTO_ENTRY_CUTOFF_MINUTES_TO_CLOSE", 5);

  const baseRiskDollars = autoEnvNum("AUTO_BASE_RISK_DOLLARS", 50);

  const token = autoEnvStr("AUTO_ENTRY_TOKEN", "");

  // C-tier execution quality gates — permissive to maximize throughput;
  // hard structural checks (extreme illiquidity, invalid stops) still apply.
  const allowCTier = autoEnvBool("AUTO_ENTRY_ALLOW_C_TIER", true);
  const cMinScore = autoEnvNum("AUTO_ENTRY_C_MIN_SCORE", 6.2);
  const cMinRelVol = autoEnvNum("AUTO_ENTRY_C_MIN_RELVOL", 0.8);
  const requireTrendAlignment = autoEnvBool("AUTO_ENTRY_REQUIRE_TREND_ALIGNMENT", false);
  const cMinRR = autoEnvNum("AUTO_ENTRY_C_MIN_RR", 1.5);

  return {
    enabled,
    paperOnly,
    allowedTiers,
    tierAmin,
    tierBmin,
    tierCmin,
    maxOpen,
    maxPerDay,
    cooldownMin,
    cutoffMinutesToClose,
    baseRiskDollars,
    token,
    // C-tier quality gates
    allowCTier,
    cMinScore,
    cMinRelVol,
    requireTrendAlignment,
    cMinRR,
  };
}

export function tierForScore(score: number): AutoTier | null {
  const a = autoEnvNum("AUTO_TIER_A_MIN", 8.0);
  const b = autoEnvNum("AUTO_TIER_B_MIN", 7.0);
  const c = autoEnvNum("AUTO_TIER_C_MIN", 6.0);
  if (score >= a) return "A";
  if (score >= b) return "B";
  if (score >= c) return "C";
  return null;
}

export function riskMultForTier(tier: AutoTier) {
  if (tier === "A") return 2.0;
  if (tier === "B") return 1.5;
  return 1.0;
}
