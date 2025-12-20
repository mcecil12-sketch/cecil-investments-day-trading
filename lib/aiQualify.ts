export type AiGrade = "A+" | "A" | "A-" | "B+" | "B" | "B-" | "C+" | "C" | "C" | "C-" | "D" | "F";

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
  const min = envNum("AI_MIN_SCORE_TO_QUALIFY", 7.0);
  return Number.isFinite(score) && score >= min;
}

export function qualifyByGrade(grade: AiGrade): boolean {
  const min = envGrade("AI_MIN_GRADE_TO_QUALIFY", "B");
  return gradeRank[grade] >= gradeRank[min];
}

export function minScoreToQualify() {
  return envNum("AI_MIN_SCORE_TO_QUALIFY", 7.0);
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

export function minScoreToQualify() {
  return envNum("AI_MIN_SCORE_TO_QUALIFY", 7.0);
}
