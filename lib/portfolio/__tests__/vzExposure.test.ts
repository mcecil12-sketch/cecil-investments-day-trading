import { describe, expect, it } from "vitest";
import { computeVzExposure, computeVzPriceStats, formatVzExposureLine, isVerizonStockHolding, type VzExposureAccount } from "@/lib/portfolio/vzExposure";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const price = { last: 40, dayChangePct: 0.01, ytdChangePct: 0.1 };

describe("computeVzPriceStats", () => {
  it("computes day and YTD change from closes", () => {
    const stats = computeVzPriceStats(
      [
        { date: d("2025-12-30"), close: 36 },
        { date: d("2025-12-31"), close: 40 },
        { date: d("2026-10-08"), close: 42 },
        { date: d("2026-10-09"), close: 44 },
      ],
      d("2026-10-10"),
    );
    expect(stats?.last).toBe(44);
    expect(stats?.dayChangePct).toBeCloseTo(44 / 42 - 1);
    expect(stats?.ytdChangePct).toBeCloseTo(0.1);
  });

  it("returns null YTD with no prior-year close and null for empty series", () => {
    expect(computeVzPriceStats([{ date: d("2026-10-09"), close: 44 }], d("2026-10-10"))?.ytdChangePct).toBeNull();
    expect(computeVzPriceStats([])).toBeNull();
  });
});

describe("isVerizonStockHolding", () => {
  it("matches the VZ symbol and stock funds, but not target-date funds", () => {
    expect(isVerizonStockHolding({ symbol: "VZ", name: null })).toBe(true);
    expect(isVerizonStockHolding({ symbol: "VERIZON STOCK FUND", name: "Verizon Stock Fund" })).toBe(true);
    expect(isVerizonStockHolding({ symbol: "VERIZON 2070 FUND", name: "VERIZON 2070 FUND" })).toBe(false);
    expect(isVerizonStockHolding({ symbol: "FXAIX", name: "Fidelity 500 Index" })).toBe(false);
  });
});

describe("computeVzExposure", () => {
  const accounts: VzExposureAccount[] = [
    { name: "EDP", type: "VZ_EDP", holdings: [{ symbol: "VERIZON STOCK FUND", name: "Verizon Stock Fund", currentValue: 1000, lastPrice: 1 }] },
    { name: "LTI", type: "VZ_LTI", holdings: [], ltiShares: 100, ltiFrozenValue: 3000 },
    {
      name: "Savings",
      type: "VZ_SAVINGS_401K",
      holdings: [
        { symbol: "VERIZON 2070 FUND", name: "VERIZON 2070 FUND", currentValue: 5000, lastPrice: 5 },
        { symbol: "FXAIX", name: "Index", currentValue: 9999, lastPrice: 1 },
      ],
    },
    { name: "Mid-Atlantic", type: "VZ_LEGACY_401K", holdings: [{ symbol: "FXAIX", name: "Index", currentValue: 800, lastPrice: 1 }] },
    { name: "Taxable", type: "FIDELITY_TAXABLE", holdings: [{ symbol: "VZ", name: "VZ", currentValue: 200, lastPrice: null }] },
  ];

  it("counts stock fund + VZ symbol + LTI shares x price; target-date fund goes to Excluded", () => {
    const e = computeVzExposure({ accounts, price, totalPortfolioValue: 10000 });
    expect(e.totalValue).toBe(1000 + 4000 + 200);
    expect(e.components.map((c) => c.accountName)).toEqual(["EDP", "LTI", "Taxable"]);
    expect(e.excluded).toHaveLength(1);
    expect(e.excluded[0]).toMatchObject({ accountName: "Savings", label: "VERIZON 2070 FUND", value: 5000 });
    expect(e.excluded[0].reason).toMatch(/target-date/);
    expect(e.notes.some((n) => /look-through/.test(n))).toBe(true);
  });

  it("reports exposure both including and excluding unvested LTI, each against its matching total", () => {
    const e = computeVzExposure({ accounts, price, totalPortfolioValue: 10000 });
    expect(e.percentOfPortfolio).toBeCloseTo(5200 / 10000);
    expect(e.excludingLti.totalValue).toBe(1200);
    // portfolio total with the 4000 of LTI removed from the denominator too
    expect(e.excludingLti.percentOfPortfolio).toBeCloseTo(1200 / 6000);
  });

  it("counts a holding with no price at its imported value and says so", () => {
    const e = computeVzExposure({ accounts, price, totalPortfolioValue: 10000 });
    expect(e.components.find((c) => c.accountName === "Taxable")?.value).toBe(200);
    expect(e.notes.some((n) => n.includes("no price"))).toBe(true);
  });

  it("falls back to the frozen LTI value when there is no live price", () => {
    const e = computeVzExposure({ accounts, price: null, totalPortfolioValue: null });
    expect(e.components.find((c) => c.accountName === "LTI")?.value).toBe(3000);
    expect(e.percentOfPortfolio).toBeNull();
    expect(e.excludingLti.percentOfPortfolio).toBeNull();
  });

  it("handles no Verizon exposure anywhere", () => {
    const e = computeVzExposure({ accounts: [accounts[3]], price, totalPortfolioValue: 800 });
    expect(e.totalValue).toBe(0);
    expect(e.components).toEqual([]);
  });

  it("formats the card line with both views", () => {
    const e = computeVzExposure({ accounts, price, totalPortfolioValue: 10000 });
    expect(formatVzExposureLine(e)).toBe(
      "Verizon-linked exposure: $5,200 (52.0% of portfolio) incl. unvested LTI; $1,200 (20.0%) excl. LTI, VZ day +1.0%, YTD +10.0%",
    );
  });
});
