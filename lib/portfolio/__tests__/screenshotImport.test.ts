import { describe, expect, it } from "vitest";
import { parseExtractionResponse, positionsToHoldingRows } from "@/lib/portfolio/screenshotImport";

const VALID_JSON = JSON.stringify({
  accountName: "Individual Brokerage Account",
  asOfDate: "07/08/2026",
  positions: [
    {
      symbol: "AAPL",
      name: "APPLE INC",
      quantity: 15,
      lastPrice: 225.3,
      currentValue: 3379.5,
      costBasis: 2700,
      gainLoss: 679.5,
      gainLossPercent: 25.17,
      percentOfAccount: 34.2,
    },
  ],
});

describe("parseExtractionResponse", () => {
  it("parses a plain JSON response", () => {
    const result = parseExtractionResponse(VALID_JSON);
    expect(result.accountName).toBe("Individual Brokerage Account");
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].symbol).toBe("AAPL");
  });

  it("strips a markdown code fence Claude adds despite instructions not to", () => {
    const fenced = "```json\n" + VALID_JSON + "\n```";
    const result = parseExtractionResponse(fenced);
    expect(result.positions[0].symbol).toBe("AAPL");
  });

  it("throws a clear error on malformed JSON", () => {
    expect(() => parseExtractionResponse("not json at all")).toThrow(/valid JSON/);
  });

  it("throws when required top-level fields are missing", () => {
    expect(() => parseExtractionResponse(JSON.stringify({ positions: [] }))).toThrow(
      /accountName or asOfDate/,
    );
  });

  it("throws when a position is missing required numeric fields", () => {
    const malformed = JSON.stringify({
      accountName: "X",
      asOfDate: "2026-07-08",
      positions: [{ symbol: "AAPL", name: "APPLE INC" }],
    });
    expect(() => parseExtractionResponse(malformed)).toThrow(/malformed positions/);
  });
});

describe("positionsToHoldingRows", () => {
  it("classifies a money-market position as CASH", () => {
    const [row] = positionsToHoldingRows([
      {
        symbol: "SPAXX",
        name: "FIDELITY GOVERNMENT MONEY MARKET",
        quantity: 100,
        lastPrice: 1,
        currentValue: 100,
        costBasis: 100,
        gainLoss: 0,
        gainLossPercent: 0,
        percentOfAccount: 10,
      },
    ]);
    expect(row.type).toBe("CASH");
  });

  it("classifies a named index fund as FUND", () => {
    const [row] = positionsToHoldingRows([
      {
        symbol: "FXAIX",
        name: "FIDELITY 500 INDEX FUND",
        quantity: 10,
        lastPrice: 180,
        currentValue: 1800,
        costBasis: 1500,
        gainLoss: 300,
        gainLossPercent: 20,
        percentOfAccount: 50,
      },
    ]);
    expect(row.type).toBe("FUND");
  });

  it("defaults an ordinary equity to STOCK", () => {
    const [row] = positionsToHoldingRows([
      {
        symbol: "AAPL",
        name: "APPLE INC",
        quantity: 15,
        lastPrice: 225.3,
        currentValue: 3379.5,
        costBasis: 2700,
        gainLoss: 679.5,
        gainLossPercent: 25.17,
        percentOfAccount: 34.2,
      },
    ]);
    expect(row.type).toBe("STOCK");
    expect(row.averageCostBasis).toBeCloseTo(180);
  });

  it("guards against divide-by-zero when quantity is 0", () => {
    const [row] = positionsToHoldingRows([
      {
        symbol: "AAPL",
        name: "APPLE INC",
        quantity: 0,
        lastPrice: 225.3,
        currentValue: 0,
        costBasis: 0,
        gainLoss: 0,
        gainLossPercent: 0,
        percentOfAccount: 0,
      },
    ]);
    expect(row.averageCostBasis).toBeNull();
  });
});
