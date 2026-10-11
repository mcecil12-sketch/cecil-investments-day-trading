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
        sentimentScore: 62,
        sentimentCoverage: "scored",
        extensionVs200d: 0.31,
        vol60d: 0.72,
        lastClose: 123.45,
        priceDate: "2026-08-21",
        fragilityPercentile: 91,
        fragilityFlag: true,
        insiderNetSoldUsd30d: 27700000,
        insiderSaleCount30d: 4,
        insiderSellers30d: 2,
        insiderHas10b5_1: null,
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

  it("logs the scan close and its price date (the price behind the later market-cap lookup); market cap itself is filled by the enrichment pass", async () => {
    createMany.mockClear();
    createMany.mockResolvedValueOnce({ count: 1 });
    await logMonthlyScanBatch("run1", output({ triggerSource: "cron" }));
    const row = createMany.mock.calls[0][0].data[0];
    expect(row.scanClose).toBe(123.45);
    expect(row.priceDate).toEqual(new Date("2026-08-21T00:00:00Z"));
    expect(row).not.toHaveProperty("marketCap");
    expect(row.insiderFetchedAt).toBeUndefined();
  });

  it("never persists rows for a manual/test run — Group 3's banding and performance replay every GROUP_3 row unconditionally, so a manual run must not reach the table at all", async () => {
    createMany.mockClear();
    await logMonthlyScanBatch("run2", output({ triggerSource: "manual" }));
    expect(createMany).not.toHaveBeenCalled();
  });
});
