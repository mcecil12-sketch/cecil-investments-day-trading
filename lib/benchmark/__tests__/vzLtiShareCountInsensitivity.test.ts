import { beforeEach, describe, expect, it, vi } from "vitest";

const day = (iso: string) => new Date(`${iso}T14:30:00Z`);

const tranches = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    account: {
      findMany: async () => [
        { id: "vz", name: "Verizon LTI", type: "VZ_LTI", isLocked: true, createdAt: day("2024-01-02") },
      ],
      findUnique: async () => ({ type: "VZ_LTI" }),
    },
    importBatch: { findFirst: async () => ({ id: "batch1", asOfDate: day("2026-03-04") }) },
    vzLtiTranche: { findMany: tranches },
    accountPerformance: { findMany: async () => [] },
  },
}));

vi.mock("@/lib/benchmark/priceCache", () => ({
  ensureSp500PriceCache: async () => {},
  getSp500CloseOnOrBefore: async () => null,
}));

const getAdjustedCloseHistory = vi.fn(async (symbol: string) =>
  symbol === "VZ"
    ? [
        { date: day("2025-03-03"), close: 100 },
        { date: day("2025-12-31"), close: 110 },
        { date: day("2026-03-04"), close: 132 },
      ]
    : [
        { date: day("2025-03-03"), close: 1000 },
        { date: day("2025-12-31"), close: 1100 },
        { date: day("2026-03-04"), close: 1210 },
      ],
);
vi.mock("@/lib/agents/marketData", () => ({
  VZ_SYMBOL: "VZ",
  getAdjustedCloseHistory,
  getLatestPrice: async () => ({ price: 45, asOf: day("2026-03-04"), source: "yahoo" }),
}));

const { computeBenchmark } = await import("@/lib/benchmark/engine");

function tranche(shares: number, cohortLabel: string) {
  return { cohortLabel, grantYear: 2024, vestDate: day("2027-03-01"), shares, currentValue: shares * 40 };
}

async function vzLtiResults() {
  const computation = await computeBenchmark();
  return computation.accounts.filter((a) => a.accountId === "vz");
}

describe("VZ_LTI YTD/1Y is insensitive to VzLtiTranche share-count changes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("produces identical returns/alpha across very different vesting/grant balances", async () => {
    tranches.mockResolvedValue([tranche(100, "RD24"), tranche(100, "RD25")]);
    const before = await vzLtiResults();

    // A grant vests out, a new one lands, and the balance changes ~50x.
    tranches.mockResolvedValue([tranche(5000, "RD26")]);
    const after = await vzLtiResults();

    // The scenario really did change the balance...
    expect(after[0].endValue).not.toBe(before[0].endValue);
    expect(before[0].endValue).toBeCloseTo(200 * 45);
    expect(after[0].endValue).toBeCloseTo(5000 * 45);

    // ...but none of the YTD/1Y numbers moved.
    const pick = (rows: typeof before) =>
      rows
        .filter((r) => r.period === "ytd" || r.period === "1y")
        .map((r) => ({
          period: r.period,
          dataSource: r.dataSource,
          portfolioReturn: r.portfolioReturn,
          sp500Return: r.sp500Return,
          alpha: r.alpha,
          asOfDate: r.asOfDate,
        }));
    expect(pick(after)).toEqual(pick(before));

    const ytd = pick(before).find((r) => r.period === "ytd")!;
    expect(ytd.dataSource).toBe("computed_total_return");
    expect(ytd.portfolioReturn).toBeCloseTo(132 / 110 - 1, 12);
    expect(ytd.sp500Return).toBeCloseTo(0.1, 12);
    expect(ytd.alpha).toBeCloseTo(0.2 - 0.1, 12);
  });

  it("still computes with zero tranches' worth of influence (empty balance)", async () => {
    tranches.mockResolvedValue([]);
    const rows = await vzLtiResults();
    expect(rows.find((r) => r.period === "1y")!.portfolioReturn).toBeCloseTo(0.32, 12);
  });
});
