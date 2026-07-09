/**
 * Grade-Based Exit Rules
 * 
 * Implements tiered trade management strategies based on AI signal grade:
 * 
 * A-GRADE (≥8.0): RUNNER STRATEGY
 * - Move stop to break-even at 0.75R
 * - Trail stop aggressively to capture 3R+ runners
 * - NO fixed take-profit target
 * - Goal: Let winners run, protect capital early
 * 
 * B-GRADE (7.0-7.9): PARTIAL + CAP STRATEGY
 * - Move stop to break-even at 1R
 * - Take 50% profit at 1.25R
 * - Trail remaining 50% with 2R cap
 * - Goal: Lock in gains while giving upside opportunity
 * 
 * C-GRADE (6.0-6.9): QUICK EXIT STRATEGY
 * - Move stop to break-even at 0.5R
 * - Full exit at 1R target
 * - NO trailing, NO runners
 * - Goal: Capture quick profit, minimize exposure
 * 
 * D/F-GRADE (<6.0): NOT TRADED
 * - Should not reach auto-manage (filtered at entry)
 */

export type TradeGrade = "A+" | "A" | "B" | "C" | "D" | "F";

export type GradeRule = {
  grade: TradeGrade;
  breakEvenAtR: number; // Move stop to break-even when currentR reaches this
  partialExits: Array<{ atR: number; percentSize: number }>; // Partial profit takes
  maxTargetR: number | null; // Hard cap on profit (null = no cap, runner strategy)
  enableTrailing: boolean; // Whether to trail stop after break-even
  trailStartR?: number; // Start trailing when currentR reaches this (optional)
};

/**
 * Grade Rules Configuration
 * Maps each grade to its specific management strategy
 */
export const GRADE_RULES: Record<string, GradeRule> = {
  "A+": {
    grade: "A+",
    breakEvenAtR: 0.75,
    partialExits: [], // No partials - full position stays
    maxTargetR: null, // No cap - let it run
    enableTrailing: true,
    trailStartR: 2.5, // Start trailing at 2.5R
  },
  A: {
    grade: "A",
    breakEvenAtR: 0.75,
    partialExits: [],
    maxTargetR: null,
    enableTrailing: true,
    trailStartR: 2.5,
  },
  B: {
    grade: "B",
    breakEvenAtR: 1.0,
    partialExits: [
      { atR: 1.25, percentSize: 50 }, // Take 50% at 1.25R
    ],
    maxTargetR: 2.0, // Cap at 2R
    enableTrailing: true,
    trailStartR: 1.5, // Start trailing after 50% partial
  },
  C: {
    grade: "C",
    breakEvenAtR: 0.5,
    partialExits: [],
    maxTargetR: 1.0, // Hard exit at 1R
    enableTrailing: false, // No trailing - just exit at 1R
  },
  D: {
    grade: "D",
    breakEvenAtR: 0.25, // Very tight if somehow traded
    partialExits: [],
    maxTargetR: 0.5,
    enableTrailing: false,
  },
  F: {
    grade: "F",
    breakEvenAtR: 0.1,
    partialExits: [],
    maxTargetR: 0.25,
    enableTrailing: false,
  },
};

/**
 * Get the appropriate rule for a given grade
 * Falls back to C-grade (conservative) if grade unknown
 */
export function getRuleForGrade(grade: string | null | undefined): GradeRule {
  if (!grade) return GRADE_RULES.C; // Default to conservative C-grade
  const normalized = grade.toUpperCase();
  return GRADE_RULES[normalized] || GRADE_RULES.C;
}

/**
 * Determine if a trade should be moved to break-even
 */
export function shouldMoveToBreakEven(
  currentR: number,
  grade: string | null | undefined,
  alreadyAtBreakEven: boolean
): boolean {
  if (alreadyAtBreakEven) return false;
  const rule = getRuleForGrade(grade);
  return currentR >= rule.breakEvenAtR;
}

/**
 * Determine if a partial exit should be executed
 * Returns { shouldExit: boolean, percentSize?: number, atR?: number }
 */
export function shouldTakePartial(
  currentR: number,
  grade: string | null | undefined,
  alreadyTakenPartials: number[] // Array of R levels where partials were already taken
): { shouldExit: boolean; percentSize?: number; atR?: number } {
  const rule = getRuleForGrade(grade);
  
  for (const partial of rule.partialExits) {
    // Check if we've reached this R level and haven't already taken it
    if (currentR >= partial.atR && !alreadyTakenPartials.includes(partial.atR)) {
      return {
        shouldExit: true,
        percentSize: partial.percentSize,
        atR: partial.atR,
      };
    }
  }
  
  return { shouldExit: false };
}

/**
 * Determine if a full exit at target should be executed
 */
export function shouldExitAtTarget(
  currentR: number,
  grade: string | null | undefined,
  alreadyExited: boolean
): boolean {
  if (alreadyExited) return false;
  const rule = getRuleForGrade(grade);
  
  // If maxTargetR is null, this is a runner strategy (no hard cap)
  if (rule.maxTargetR === null) return false;
  
  return currentR >= rule.maxTargetR;
}

/**
 * Determine if trailing should be enabled for this trade
 */
export function shouldEnableTrailing(
  currentR: number,
  grade: string | null | undefined
): boolean {
  const rule = getRuleForGrade(grade);
  if (!rule.enableTrailing) return false;
  
  // If trailStartR is specified, only enable trailing after reaching that R
  if (rule.trailStartR !== undefined) {
    return currentR >= rule.trailStartR;
  }
  
  // Otherwise, enable trailing once break-even is hit
  return currentR >= rule.breakEvenAtR;
}

/**
 * Get a human-readable description of the grade rule
 */
export function describeGradeRule(grade: string | null | undefined): string {
  const rule = getRuleForGrade(grade);
  const gradeLabel = rule.grade;
  
  if (gradeLabel === "A+" || gradeLabel === "A") {
    return `${gradeLabel}-grade: Runner strategy (BE @ ${rule.breakEvenAtR}R, trail @ ${rule.trailStartR}R, no cap)`;
  }
  
  if (gradeLabel === "B") {
    const partial = rule.partialExits[0];
    return `${gradeLabel}-grade: Partial strategy (BE @ ${rule.breakEvenAtR}R, ${partial?.percentSize}% @ ${partial?.atR}R, cap @ ${rule.maxTargetR}R)`;
  }
  
  return `${gradeLabel}-grade: Quick exit (BE @ ${rule.breakEvenAtR}R, exit @ ${rule.maxTargetR}R)`;
}
