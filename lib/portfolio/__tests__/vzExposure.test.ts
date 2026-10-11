import { describe, expect, it } from "vitest";
import { computeVzExposure, computeVzPriceStats, formatVzExposureLine, type VzExposureAccount } from "@/lib/portfolio/vzExposure";

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

describe("computeVzExposure", () => {
  const accounts: VzExposureAccount[] = [
    { name: "EDP", type: "VZ_EDP", holdings: [{ symbol: "EDPFUND", name: "Mgmt Fund", currentValue: 1000, lastPrice: 1 }] },
    { name: "LTI", type: "VZ_LTI", holdings: [], ltiShares: 100, ltiFrozenValue: 3000 },
    {
      name: "Savings",
      type: "VZ_SAVINGS_401K",
      holdings: [
        { symbol: "VZSTK", name: "Verizon Stock Fund", currentValue: 500, lastPrice: 5 },
        { symbol: "FXAIX", name: "Index", currentValue: 9999, lastPrice: 1 },
      ],
    },
    { name: "Mid-Atlantic", type: "VZ_LEGACY_401K", holdings: [{ symbol: "FXAIX", name: "Index", currentValue: 800, lastPrice: 1 }] },
    { name: "Taxable", type: "FIDELITY_TAXABLE", holdings: [{ symbol: "VZ", name: "VZ", currentValue: 200, lastPrice: null }] },
  ];

  it("totals EDP (assumed), LTI shares x price, and matched holdings; skips plans with no VZ", () => {
    const e = computeVzExposure({ accounts, price, totalPortfolioValue: 10000 });
    expect(e.totalValue).toBe(1000 + 4000 + 500 + 200);
    expect(e.percentOfPortfolio).toBeCloseTo(0.57);
    expect(e.components.map((c) => c.accountName)).toEqual(["EDP", "LTI", "Savings", "Taxable"]);
    expect(e.components.find((c) => c.accountName === "Mid-Atlantic")).toBeUndefined();
    expect(e.notes.some((n) => n.includes("EDP") && n.includes("assumed"))).toBe(true);
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
  });

  it("only counts matched EDP holdings when the EDP has a Verizon-named one", () => {
    const e = computeVzExposure({
      accounts: [
        {
          name: "EDP",
          type: "VZ_EDP",
          holdings: [
            { symbol: "X", name: "VERIZON STOCK FUND", currentValue: 700, lastPrice: 1 },
            { symbol: "Y", name: "Bond Fund", currentValue: 300, lastPrice: 1 },
          ],
        },
      ],
      price,
      totalPortfolioValue: 1000,
    });
    expect(e.totalValue).toBe(700);
  });

  it("handles no Verizon exposure anywhere", () => {
    const e = computeVzExposure({ accounts: [accounts[3]], price, totalPortfolioValue: 800 });
    expect(e.totalValue).toBe(0);
    expect(e.components).toEqual([]);
  });

  it("formats the card line", () => {
    const e = computeVzExposure({ accounts, price, totalPortfolioValue: 10000 });
    expect(formatVzExposureLine(e)).toBe("Verizon-linked exposure: $5,700 (57.0% of portfolio), VZ day +1.0%, YTD +10.0%");
  });
});
