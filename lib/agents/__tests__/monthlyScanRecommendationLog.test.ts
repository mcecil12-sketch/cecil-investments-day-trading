import { describe, expect, it, vi } from "vitest";
import type { MonthlyScanOutput } from "@/lib/agents/monthlyScan";

const createMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { candidateRecommendationLog: { createMany } },
}));

const { logMonthlyScanBatch } = await import("@/lib/agents/monthlyScanRecommendationLog");

function output(overrides: Partial<MonthlyScanOutput> = {}): MonthlyScanOutput {
  return {
    generatedAt: "2026-08-24T00:00:00.000Z",
    triggerSource: "cron",
    rankedCandidates: [
      {
        symbol: "DELL",
        name: "Dell Technologies Inc.",
        sector: "Technology",
        rank: 1,
        score: 90,
        vsSpx: 10,
        momentum1Y: 0.2,
        aboveSma50: true,
        aboveSma200: true,
        earningsSurpriseTrend: 80,
        earningsSurpriseCoverage: "sue",
        rationale: "test",
        accountType: "taxable",
        dataAvailability: {
          earningsFiscalDateEndingUsed: null,
          earningsCoverage: "sue",
          sectorRotationRunId: "run1",
          sectorRotationAsOf: "2026-08-24T00:00:00.000Z",
        },
      },
    ],
    sectorsWithoutUniverse: [],
    skipped: [],
    ...overrides,
  };
}

describe("logMonthlyScanBatch", () => {
  it("persists rows for a cron-triggered run", async () => {
    createMany.mockResolvedValueOnce({ count: 1 });
    await logMonthlyScanBatch("run1", output({ triggerSource: "cron" }));
    expect(createMany).toHaveBeenCalledTimes(1);
  });

  it("never persists rows for a manual/test run — Group 3's banding and performance replay every GROUP_3 row unconditionally, so a manual run must not reach the table at all", async () => {
    createMany.mockClear();
    await logMonthlyScanBatch("run2", output({ triggerSource: "manual" }));
    expect(createMany).not.toHaveBeenCalled();
  });
});
