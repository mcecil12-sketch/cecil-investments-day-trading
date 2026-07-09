/**
 * Reads the current AgentState and returns a normalized ExecutionOverlays object.
 * Fails soft: all fields fall back to permissive defaults when agent state is unavailable.
 *
 * Designed to be called at the top of auto-entry routes (seed-from-signals, execute).
 */

import { readAgentState } from "@/lib/agents/store";
import type { AgentPosture, AllowedGrade, EventRisk, NewsState } from "@/lib/agents/types";

export interface ExecutionOverlays {
  posture: AgentPosture;
  allowedGrades: AllowedGrade[];
  /** Extra score points required on top of the base tier threshold. */
  minScoreAdjustment: number;
  /** When set, caps the number of entries for the day. Does not raise cfg.maxPerDay. */
  maxEntriesOverride: number | null;
  activeRestrictions: string[];
  eventRisk: EventRisk;
  newsState: NewsState;
  /** True when state was read from Redis; false when using safe defaults. */
  stateAvailable: boolean;
}

const SAFE_DEFAULTS: ExecutionOverlays = {
  posture: "NORMAL",
  allowedGrades: ["A", "B", "C"],
  minScoreAdjustment: 0,
  maxEntriesOverride: null,
  activeRestrictions: [],
  eventRisk: "LOW",
  newsState: "CALM",
  stateAvailable: false,
};

export async function readExecutionOverlays(): Promise<ExecutionOverlays> {
  try {
    const snapshot = await readAgentState();
    if (!snapshot) return { ...SAFE_DEFAULTS };

    // Validate and fall back field-by-field
    const posture: AgentPosture =
      snapshot.posture === "AGGRESSIVE" || snapshot.posture === "DEFENSIVE" || snapshot.posture === "NORMAL"
        ? snapshot.posture
        : SAFE_DEFAULTS.posture;

    const allowedGrades: AllowedGrade[] =
      Array.isArray(snapshot.allowedGrades) && snapshot.allowedGrades.length > 0
        ? (snapshot.allowedGrades.filter((g) => g === "A" || g === "B" || g === "C") as AllowedGrade[])
        : SAFE_DEFAULTS.allowedGrades;

    const minScoreAdjustment: number =
      typeof snapshot.minScoreAdjustment === "number" && Number.isFinite(snapshot.minScoreAdjustment)
        ? snapshot.minScoreAdjustment
        : 0;

    const maxEntriesOverride: number | null =
      snapshot.maxEntriesOverride != null &&
      Number.isFinite(snapshot.maxEntriesOverride) &&
      snapshot.maxEntriesOverride >= 0
        ? snapshot.maxEntriesOverride
        : null;

    const activeRestrictions: string[] = Array.isArray(snapshot.activeRestrictions)
      ? snapshot.activeRestrictions
      : [];

    const eventRisk: EventRisk =
      snapshot.eventRisk === "LOW" || snapshot.eventRisk === "MEDIUM" || snapshot.eventRisk === "HIGH"
        ? snapshot.eventRisk
        : SAFE_DEFAULTS.eventRisk;

    const newsState: NewsState =
      snapshot.newsState === "CALM" || snapshot.newsState === "ACTIVE" || snapshot.newsState === "HEADLINE_DRIVEN"
        ? snapshot.newsState
        : SAFE_DEFAULTS.newsState;

    return {
      posture,
      allowedGrades: allowedGrades.length > 0 ? allowedGrades : SAFE_DEFAULTS.allowedGrades,
      minScoreAdjustment,
      maxEntriesOverride,
      activeRestrictions,
      eventRisk,
      newsState,
      stateAvailable: true,
    };
  } catch {
    return { ...SAFE_DEFAULTS };
  }
}
