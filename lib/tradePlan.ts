import { getTradingConfig, tierForScore } from "@/lib/tradingConfig";

export type TradePlanTier = "A" | "B" | "C";

export type TradePlanMilestone =
  | { type: "MOVE_STOP_TO_BREAKEVEN"; atR: number }
  | { type: "TAKE_PROFIT_PARTIAL"; atR: number; pct: number }
  | { type: "START_TRAIL"; atR: number; trailR: number }
  | { type: "FLATTEN_BY_TIME"; timeET: string };

export type TradePlan = {
  version: "v1";
  tier: TradePlanTier;
  score: number;
  side: "LONG" | "SHORT";
  entryPrice: number;
  stopPrice: number;
  rPerShare: number;
  riskMultiplier: number;
  liquidityTag?: string;
  milestones: TradePlanMilestone[];
  notes?: string;
};

function isNum(x: any): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function round(n: number, d = 4) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

export function buildDefaultTradePlan(args: {
  score: number;
  side: "LONG" | "SHORT";
  entryPrice: number;
  stopPrice: number;
  liquidityTag?: string;
}): TradePlan | null {
  const cfg = getTradingConfig();

  if (!isNum(args.score) || !isNum(args.entryPrice) || !isNum(args.stopPrice)) return null;
  if (args.entryPrice <= 0 || args.stopPrice <= 0) return null;

  const tier = tierForScore(args.score);
  if (tier === "REJECT") return null;

  const riskMult =
    tier === "A" ? cfg.tiers.A.riskMult :
    tier === "B" ? cfg.tiers.B.riskMult :
    cfg.tiers.C.riskMult;

  const rPerShare = Math.abs(args.entryPrice - args.stopPrice);
  if (!(rPerShare > 0)) return null;

  const milestones: TradePlanMilestone[] = [];
  const isC = tier === "C";

  milestones.push({ type: "MOVE_STOP_TO_BREAKEVEN", atR: 1.0 });

  if (isC) {
    milestones.push({ type: "TAKE_PROFIT_PARTIAL", atR: 1.0, pct: 50 });
    milestones.push({ type: "TAKE_PROFIT_PARTIAL", atR: 2.0, pct: 25 });
    milestones.push({ type: "START_TRAIL", atR: 2.0, trailR: 1.0 });
  } else {
    milestones.push({ type: "TAKE_PROFIT_PARTIAL", atR: 1.0, pct: 33 });
    milestones.push({ type: "TAKE_PROFIT_PARTIAL", atR: 2.0, pct: 33 });
    milestones.push({ type: "START_TRAIL", atR: 2.0, trailR: 1.0 });
  }

  milestones.push({ type: "FLATTEN_BY_TIME", timeET: cfg.lifecycle.flattenByET });

  return {
    version: "v1",
    tier: tier as TradePlanTier,
    score: round(args.score, 3),
    side: args.side,
    entryPrice: round(args.entryPrice, 4),
    stopPrice: round(args.stopPrice, 4),
    rPerShare: round(rPerShare, 4),
    riskMultiplier: round(riskMult, 3),
    liquidityTag: args.liquidityTag,
    milestones,
  };
}

function extractFirstJsonObject(text: string): any | null {
  if (!text) return null;
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    if (depth === 0) {
      const candidate = text.slice(start, i + 1);
      try { return JSON.parse(candidate); } catch { return null; }
    }
  }
  return null;
}

function normalizeMilestones(ms: any[]): TradePlanMilestone[] {
  const out: TradePlanMilestone[] = [];
  for (const m of ms) {
    if (!m || typeof m !== "object") continue;
    const t = m.type;
    if (t === "MOVE_STOP_TO_BREAKEVEN" && isNum(m.atR)) {
      out.push({ type: "MOVE_STOP_TO_BREAKEVEN", atR: clamp(m.atR, 0.25, 5) });
    }
    if (t === "TAKE_PROFIT_PARTIAL" && isNum(m.atR) && isNum(m.pct)) {
      out.push({ type: "TAKE_PROFIT_PARTIAL", atR: clamp(m.atR, 0.25, 10), pct: clamp(m.pct, 1, 100) });
    }
    if (t === "START_TRAIL" && isNum(m.atR) && isNum(m.trailR)) {
      out.push({ type: "START_TRAIL", atR: clamp(m.atR, 0.5, 20), trailR: clamp(m.trailR, 0.25, 10) });
    }
    if (t === "FLATTEN_BY_TIME" && typeof m.timeET === "string" && m.timeET.length >= 4) {
      out.push({ type: "FLATTEN_BY_TIME", timeET: m.timeET });
    }
  }
  return out;
}

export function parseAiTradePlan(args: {
  text: string;
  score: number;
  side: "LONG" | "SHORT";
  entryPrice: number;
  stopPrice: number;
  liquidityTag?: string;
}) {
  const obj = extractFirstJsonObject(args.text);
  if (!obj || typeof obj !== "object") return null;

  const tp = (obj.tradePlan ?? obj.plan ?? obj) as any;
  if (!tp || typeof tp !== "object") return null;

  const tier = tp.tier;
  if (tier !== "A" && tier !== "B" && tier !== "C") return null;

  const cfg = getTradingConfig();
  const riskMultiplier =
    tier === "A" ? cfg.tiers.A.riskMult :
    tier === "B" ? cfg.tiers.B.riskMult :
    cfg.tiers.C.riskMult;

  const rPerShare = Math.abs(args.entryPrice - args.stopPrice);
  if (!(rPerShare > 0)) return null;

  const milestones = normalizeMilestones(Array.isArray(tp.milestones) ? tp.milestones : []);
  return {
    version: "v1" as const,
    tier,
    score: round(args.score, 3),
    side: args.side,
    entryPrice: round(args.entryPrice, 4),
    stopPrice: round(args.stopPrice, 4),
    rPerShare: round(rPerShare, 4),
    riskMultiplier: round(riskMultiplier, 3),
    liquidityTag: args.liquidityTag,
    milestones: milestones.length ? milestones : (buildDefaultTradePlan(args)?.milestones ?? []),
    notes: typeof tp.notes === "string" ? tp.notes : undefined,
  };
}
