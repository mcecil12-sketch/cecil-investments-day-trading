import { prisma } from "@/lib/prisma";
import type { MonthlyScanOutput } from "@/lib/agents/monthlyScan";

function monthTag(date: Date): string {
  return `monthly-${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Logs one CandidateRecommendationLog row per ranked Group 3 candidate,
 * tagged group: GROUP_3 and batchTag "monthly-YYYY-MM" so Group 3's history
 * is queryable the same way Group 1's weekly batches are, but keeps its own
 * independent monthly cadence and rank column — monthlyScanBanding.ts
 * replays `rank` across these batches to derive tracked positions.
 */
export async function logMonthlyScanBatch(agentRunId: string, output: MonthlyScanOutput): Promise<void> {
  if (output.rankedCandidates.length === 0) return;

  const recommendedAt = new Date(output.generatedAt);
  const batchTag = monthTag(recommendedAt);

  await prisma.candidateRecommendationLog.createMany({
    data: output.rankedCandidates.map((c) => ({
      sourceAgentRunId: agentRunId,
      batchTag,
      group: "GROUP_3",
      rank: c.rank,
      symbol: c.symbol,
      sector: c.sector,
      accountType: c.accountType,
      score: c.score,
      vsSpx: c.vsSpx,
      momentum1Y: c.momentum1Y,
      earningsSurpriseCoverage: c.earningsSurpriseCoverage,
      recommendationType: "monthly scan ranked candidate",
      recommendedAt,
    })),
  });
}
