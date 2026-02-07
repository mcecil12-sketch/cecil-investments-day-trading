import { shouldQualify } from "@/lib/aiQualify";

type ParseFailedMeta = {
  aiModel?: string | null;
  aiRawHead?: string | null;
  aiParseError?: string | null;
  aiRequestId?: string | null;
};

export function applyParseFailed(
  signal: any,
  reason: string,
  meta: ParseFailedMeta | undefined,
  nowIso: string
) {
  signal.status = "ERROR";
  signal.error = "parse_failed";
  signal.aiSummary = `parse_failed: ${reason || "unparseable"}`;
  signal.aiModel = meta?.aiModel ?? null;
  signal.aiRawHead = meta?.aiRawHead ?? null;
  signal.aiParseError = meta?.aiParseError ?? reason ?? null;
  signal.aiRequestId = meta?.aiRequestId ?? null;
  signal.scoredAt = nowIso;
  signal.updatedAt = nowIso;
  signal.scoringLockUntil = undefined;
  signal.scoringStartedAt = undefined;
  delete signal.aiScore;
  delete signal.aiGrade;
  delete signal.totalScore;
  delete signal.tradePlan;
  return signal;
}

export function applyScoreError(signal: any, reason: string | undefined, nowIso: string) {
  signal.status = "ERROR";
  signal.error = reason?.includes("timeout") ? "model_timeout" : "scoring_failed";
  signal.aiErrorReason = reason;
  signal.scoredAt = nowIso;
  signal.updatedAt = nowIso;
  signal.scoringLockUntil = undefined;
  signal.scoringStartedAt = undefined;
  return signal;
}

export function applyScoreSuccess(signal: any, scored: any, nowIso: string) {
  signal.status = "SCORED";
  signal.aiScore = scored.aiScore ?? null;
  signal.aiGrade = scored.aiGrade ?? null;
  signal.aiSummary = scored.aiSummary ?? null;
  signal.totalScore = scored.totalScore ?? null;
  signal.tradePlan = scored.tradePlan ?? null;
  signal.scoredAt = nowIso;
  signal.qualified = shouldQualify({
    score: scored.aiScore,
    grade: scored.aiGrade,
  });
  signal.shownInApp = signal.qualified;
  signal.updatedAt = nowIso;
  signal.scoringLockUntil = undefined;
  signal.scoringStartedAt = undefined;
  return signal;
}
