/**
 * News / Policy Strategist — Phase 3
 *
 * Produces a structured StrategistBrief that drives portfolio guidance and
 * agent task prioritization. v1 is rule/config driven and fully deterministic.
 * The integration contract is stable so future versions can plug in live data.
 */

import { redis } from "@/lib/redis";
import { getTtlSeconds, setWithTtl } from "@/lib/redis/ttl";
import { nowIso } from "@/lib/agents/time";
import { AGENT_STRATEGIST_KEY } from "@/lib/agents/keys";
import type { EventRisk, MarketBias, StrategistBrief } from "@/lib/agents/types";

const STORE_TTL = getTtlSeconds("TELEMETRY_DAYS");
const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

interface MarketSession {
  isWeekday: boolean;
  hour: number;
  minute: number;
  minutesAfterMidnight: number;
  dayOfWeek: string;
}

function getMarketSession(now: Date): MarketSession {
  const parts = ET_PARTS.formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday);
  return {
    isWeekday,
    hour,
    minute,
    minutesAfterMidnight: hour * 60 + minute,
    dayOfWeek: weekday,
  };
}

/**
 * Rule-based strategist decision for v1.
 * Evaluates time-of-day, day-of-week, and proximity to key market events.
 */
function deriveStrategistBrief(session: MarketSession): Omit<StrategistBrief, "id" | "createdAt"> {
  const { isWeekday, minutesAfterMidnight, dayOfWeek } = session;
  let marketBias: MarketBias = "MIXED";
  let confidence = 0.5;
  let eventRiskLevel: EventRisk = "LOW";
  const focusAreas: string[] = [];
  const reasons: string[] = [];

  if (!isWeekday) {
    marketBias = "RISK_OFF";
    confidence = 0.9;
    eventRiskLevel = "LOW";
    reasons.push("Weekend — markets closed, engineering is safe to execute.");
    focusAreas.push("engineering_improvements", "scoring_tuning", "backlog_refinement");
    return {
      marketBias,
      confidence,
      eventRiskLevel,
      exposureGuidance: "Markets closed. Low execution risk. Good window for engineering tasks.",
      rationale: reasons.join(" "),
      recommendedFocusAreas: focusAreas,
    };
  }

  // Pre-market: 04:00–09:30 ET
  if (minutesAfterMidnight >= 4 * 60 && minutesAfterMidnight < 9 * 60 + 30) {
    marketBias = "MIXED";
    confidence = 0.55;
    eventRiskLevel = "MEDIUM";
    reasons.push("Pre-market session. Early flow, lower liquidity.");
    focusAreas.push("qualification_review", "risk_parameter_check", "short_side_readiness");
  }
  // Market open window: 09:30–10:30 ET (volatile)
  else if (minutesAfterMidnight >= 9 * 60 + 30 && minutesAfterMidnight < 10 * 60 + 30) {
    marketBias = "MIXED";
    confidence = 0.45;
    eventRiskLevel = "HIGH";
    reasons.push("Market open window — high volatility, elevated event risk.");
    focusAreas.push("risk_integrity", "protection_audit", "qualification_quality");
  }
  // MOC / power hour: 15:00–16:00 ET
  else if (minutesAfterMidnight >= 15 * 60 && minutesAfterMidnight < 16 * 60) {
    marketBias = "MIXED";
    confidence = 0.5;
    eventRiskLevel = "MEDIUM";
    reasons.push("Power hour / MOC window — position management priority.");
    focusAreas.push("trade_management", "exit_quality", "deep_loss_prevention");
  }
  // Core trading hours: 10:30–15:00 ET
  else if (minutesAfterMidnight >= 10 * 60 + 30 && minutesAfterMidnight < 15 * 60) {
    marketBias = "LONG"; // default daytime bias until macro data available
    confidence = 0.6;
    eventRiskLevel = "LOW";
    reasons.push("Core session. Steady trading conditions.");
    focusAreas.push("signal_quality", "scoring_determinism", "short_side_capability");
    // Monday open tends to gap risk
    if (dayOfWeek === "Mon") {
      eventRiskLevel = "MEDIUM";
      confidence = 0.55;
      reasons.push("Monday — potential gap risk from weekend news.");
    }
    // Friday afternoon — reduce LONG bias
    if (dayOfWeek === "Fri" && minutesAfterMidnight >= 14 * 60) {
      marketBias = "MIXED";
      confidence = 0.5;
      reasons.push("Friday afternoon — position trimming expected.");
    }
  }
  // After-hours: 16:00–20:00 ET
  else if (minutesAfterMidnight >= 16 * 60 && minutesAfterMidnight < 20 * 60) {
    marketBias = "RISK_OFF";
    confidence = 0.7;
    eventRiskLevel = "LOW";
    reasons.push("After-hours. Markets closed. Engineering window open.");
    focusAreas.push("engineering_improvements", "performance_review", "next_day_prep");
  }
  // Overnight
  else {
    marketBias = "RISK_OFF";
    confidence = 0.8;
    eventRiskLevel = "LOW";
    reasons.push("Overnight / off-hours. Safe engineering window.");
    focusAreas.push("engineering_improvements", "scoring_tuning", "deep_loss_prevention");
  }

  const exposureMap: Record<MarketBias, string> = {
    LONG: "Lean long. Prefer high-quality A/B setups. Maintain stops.",
    SHORT: "Lean short. Ensure short-side scoring is calibrated. Manage size.",
    MIXED: "Balanced exposure. Apply standard qualification filters.",
    RISK_OFF: "Minimize active exposure. Prioritize protection and engineering.",
  };

  return {
    marketBias,
    confidence,
    eventRiskLevel,
    exposureGuidance: exposureMap[marketBias],
    rationale: reasons.join(" "),
    recommendedFocusAreas: focusAreas,
  };
}

// ─── Persistence ─────────────────────────────────────────────────────────────

async function readStoredBrief(): Promise<StrategistBrief | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get<string>(AGENT_STRATEGIST_KEY);
    if (!raw) return null;
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === "object" && "id" in parsed && "marketBias" in parsed) {
      return parsed as StrategistBrief;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeBrief(brief: StrategistBrief): Promise<void> {
  if (!redis) return;
  try {
    await setWithTtl(redis, AGENT_STRATEGIST_KEY, JSON.stringify(brief), STORE_TTL);
  } catch {
    // non-fatal
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Generate a fresh strategist brief and persist it. */
export async function generateStrategistBrief(): Promise<StrategistBrief> {
  const now = nowIso();
  const session = getMarketSession(new Date());
  const derived = deriveStrategistBrief(session);
  const brief: StrategistBrief = {
    id: crypto.randomUUID(),
    createdAt: now,
    ...derived,
  };
  await writeBrief(brief);
  return brief;
}

/**
 * Return the current strategist brief.
 * If one was persisted recently (same ISO minute), reuse it.
 * Otherwise generate a fresh one.
 */
export async function getStrategistBrief(): Promise<StrategistBrief> {
  const stored = await readStoredBrief();
  if (stored) {
    // Reuse if created within the last 5 minutes
    const ageMs = Date.now() - new Date(stored.createdAt).getTime();
    if (ageMs < 5 * 60 * 1000) return stored;
  }
  return generateStrategistBrief();
}
