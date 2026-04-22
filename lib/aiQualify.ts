export type AiGrade = "A+" | "A" | "A-" | "B+" | "B" | "B-" | "C+" | "C" | "C" | "C-" | "D" | "F";

/**
 * Qualification Tier Thresholds (score-based):
 * - A tier: >= 8.5  (elite, high-conviction)
 * - B tier: 7.5-8.49 (good, solid setups)
 * - C tier: 7.0-7.49 (qualified, minimum threshold)
 * - Below 7.0: Not qualified for auto-entry
 */
export type QualificationTier = "A" | "B" | "C" | "REJECT";

const gradeRank: Record<AiGrade, number> = {
  "A+": 12,
  "A": 11,
  "A-": 10,
  "B+": 9,
  "B": 8,
  "B-": 7,
  "C+": 6,
  "C": 5,
  "C-": 4,
  "D": 3,
  "F": 2,
};

function envNum(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envGrade(name: string, fallback: AiGrade): AiGrade {
  const raw = (process.env[name] || "").trim().toUpperCase();
  if (!raw) return fallback;
  const g = raw as AiGrade;
  return gradeRank[g] ? g : fallback;
}

export function qualifyByScore(score: number): boolean {
  const min = envNum("AI_MIN_SCORE_TO_QUALIFY", 5.5);
  return Number.isFinite(score) && score >= min;
}

export function qualifyByGrade(grade: AiGrade): boolean {
  const min = envGrade("AI_MIN_GRADE_TO_QUALIFY", "B");
  return gradeRank[grade] >= gradeRank[min];
}

/**
 * Single source of truth for the minimum score to qualify.
 * Both qualifyByScore and aiScoring.ts must use this same default.
 * Default 5.5: calibrated to actual live AI score distribution (clusters 5.0–6.5).
 * Weak flat mean-reversion longs still fail via quality penalties; valid setups pass.
 */
export function minScoreToQualify() {
  return envNum("AI_MIN_SCORE_TO_QUALIFY", 5.5);
}

/**
 * Get the qualification tier for a given score.
 * Used for tier-based tracking and analysis.
 * 
 * @param score The AI score (0-10)
 * @returns Qualification tier: A (>=8.5), B (7.5-8.49), C (7.0-7.49), REJECT (<7.0)
 */
export function getQualificationTier(score: number): QualificationTier {
  if (!Number.isFinite(score)) return "REJECT";
  if (score >= 8.0) return "A";
  if (score >= 6.5) return "B";
  if (score >= 5.5) return "C";
  return "REJECT";
}

/**
 * Get the tier thresholds for reference.
 * Used by callers to understand qualification boundaries.
 */
export function getTierThresholds() {
  return {
    A: { min: 8.0, max: 10.0, description: "Elite, high-conviction" },
    B: { min: 6.5, max: 7.99, description: "Good, solid setups" },
    C: { min: 5.5, max: 6.49, description: "Qualified, minimum threshold" },
    REJECT: { min: 0, max: 5.49, description: "Not qualified for auto-entry" },
  };
}

export function shouldQualify(input: { score?: number | null; grade?: AiGrade | string | null }) {
  const mode = (process.env.AI_QUALIFY_MODE || "score").toLowerCase();
  const score = typeof input.score === "number" ? input.score : null;
  const grade = (typeof input.grade === "string" ? (input.grade.toUpperCase() as AiGrade) : null) as AiGrade | null;

  if (mode === "grade" && grade) return qualifyByGrade(grade);
  if (score !== null) return qualifyByScore(score);
  if (grade) return qualifyByGrade(grade);
  return false;
}
