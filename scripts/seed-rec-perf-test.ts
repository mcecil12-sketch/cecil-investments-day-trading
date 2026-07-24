import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function utcMidnight(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function main() {
  const run = await prisma.agentRun.create({
    data: { agentType: "CANDIDATE_SCANNER", status: "COMPLETE", completedAt: new Date() },
  });

  const batch1 = daysAgo(45);
  const batch2 = daysAgo(10);
  const batch3 = new Date();

  await prisma.candidateRecommendationLog.createMany({
    data: [
      { sourceAgentRunId: run.id, batchTag: "top15-batch1", symbol: "AAPL", sector: "Technology", accountType: "FIDELITY_TAXABLE", score: 92, vsSpx: 12.3, momentum1Y: 0.18, recommendationType: "highest conviction opportunity", recommendedAt: batch1 },
      { sourceAgentRunId: run.id, batchTag: "top15-batch1", symbol: "MSFT", sector: "Technology", accountType: "FIDELITY_TAXABLE", score: 85, vsSpx: 8.1, momentum1Y: 0.12, recommendationType: "highest conviction opportunity", recommendedAt: batch1 },
      { sourceAgentRunId: run.id, batchTag: "top15-batch2", symbol: "NVDA", sector: "Technology", accountType: "FIDELITY_TAXABLE", score: 95, vsSpx: 20.5, momentum1Y: 0.35, recommendationType: "highest conviction opportunity", recommendedAt: batch2 },
      { sourceAgentRunId: run.id, batchTag: "top15-batch2", symbol: "JNJ", sector: "Health Care", accountType: "FIDELITY_TAXABLE", score: 72, vsSpx: 1.2, momentum1Y: 0.02, recommendationType: "highest conviction opportunity", recommendedAt: batch2 },
      { sourceAgentRunId: run.id, batchTag: "top15-batch3", symbol: "AAPL", sector: "Technology", accountType: "FIDELITY_TAXABLE", score: 88, vsSpx: 5.0, momentum1Y: 0.10, recommendationType: "highest conviction opportunity", recommendedAt: batch3 },
    ],
  });

  // Synthetic S&P series so the chart renders even if the live Yahoo fetch is rate-limited.
  const days = 60;
  let close = 5000;
  for (let i = days; i >= 0; i--) {
    const date = utcMidnight(daysAgo(i));
    close = close * (1 + (Math.sin(i / 7) * 0.002));
    await prisma.benchmarkPrice.upsert({
      where: { date },
      create: { date, close },
      update: { close },
    });
  }

  console.log("Seeded run:", run.id);
}

main().finally(() => prisma.$disconnect());
