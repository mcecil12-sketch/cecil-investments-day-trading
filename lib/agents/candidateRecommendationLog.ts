import { prisma } from "@/lib/prisma";
import type { CandidateScannerOutput } from "@/lib/agents/candidateScanner";
import { relativePerformanceSince } from "@/lib/agents/performanceAudit";

function dateTag(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Logs one CandidateRecommendationLog row per Top Candidate from a completed
 * Candidate Scanner run, tagged with the run's scan date ("top15-YYYY-MM-DD")
 * so successive weekly refreshes are chronologically distinguishable. Runs
 * unconditionally — unlike RecommendationOutcome, this tracks every surfaced
 * candidate, not just ones a human confirmed trading.
 */
export async function logCandidateRecommendationBatch(
  agentRunId: string,
  output: CandidateScannerOutput,
): Promise<void> {
  if (output.topCandidates.length === 0) return;

  const recommendedAt = new Date(output.generatedAt);
  const batchTag = `top15-${dateTag(recommendedAt)}`;

  await prisma.candidateRecommendationLog.createMany({
    data: output.topCandidates.map((c) => ({
      sourceAgentRunId: agentRunId,
      batchTag,
      symbol: c.symbol,
      sector: c.sector,
      accountType: c.accountType,
      score: c.score,
      vsSpx: c.vsSpx,
      momentum1Y: c.momentum1Y,
      recommendationType: "highest conviction opportunity",
      recommendedAt,
    })),
  });
}

/**
 * Fills in outcome30d/outcome90d for every logged candidate that's old
 * enough and doesn't have them yet — same relativePerformanceSince logic as
 * refreshRecommendationOutcomes (performanceAudit.ts), just unconditional on
 * "executed" since every row here was actually surfaced, not just acted on.
 */
export async function refreshCandidateRecommendationOutcomes(): Promise<void> {
  const pending = await prisma.candidateRecommendationLog.findMany({
    where: { OR: [{ outcome30d: null }, { outcome90d: null }] },
  });

  for (const entry of pending) {
    const updates: { outcome30d?: number; outcome90d?: number } = {};
    if (entry.outcome30d == null) {
      const value = await relativePerformanceSince(entry.symbol, entry.recommendedAt, 30);
      if (value != null) updates.outcome30d = value;
    }
    if (entry.outcome90d == null) {
      const value = await relativePerformanceSince(entry.symbol, entry.recommendedAt, 90);
      if (value != null) updates.outcome90d = value;
    }
    if (Object.keys(updates).length > 0) {
      await prisma.candidateRecommendationLog.update({ where: { id: entry.id }, data: updates });
    }
  }
}
