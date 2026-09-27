import { describe, expect, it } from "vitest";
import { parsePdfExtractionResponse, pdfPositionsToHoldingRows } from "@/lib/portfolio/pdfImport";

const VALID_JSON = JSON.stringify({
  asOfDate: "2026-09-01",
  accounts: [
    {
      accountName: "Individual Brokerage",
      accountNumber: "Z12345678",
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
    },
  ],
});

describe("parsePdfExtractionResponse", () => {
  it("parses a plain JSON response", () => {
    const result = parsePdfExtractionResponse(VALID_JSON);
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].positions[0].symbol).toBe("AAPL");
  });

  it("throws a clear error on malformed JSON", () => {
    expect(() => parsePdfExtractionResponse("not json at all")).toThrow(/valid JSON/);
  });

  it("throws when asOfDate is missing", () => {
    expect(() => parsePdfExtractionResponse(JSON.stringify({ accounts: [] }))).toThrow(/asOfDate/);
  });

  it("accepts an account with zero positions (cash-only account)", () => {
    const cashOnly = JSON.stringify({
      asOfDate: "2026-09-01",
      accounts: [{ accountName: "Gifts and Trips", accountNumber: "Z98765432", positions: [] }],
    });
    const result = parsePdfExtractionResponse(cashOnly);
    expect(result.accounts[0].positions).toEqual([]);
  });

  it("defaults accountNumber and positions when the model omits them for a sparse account", () => {
    const sparse = JSON.stringify({
      asOfDate: "2026-09-01",
      accounts: [{ accountName: "Gifts and Trips" }],
    });
    const result = parsePdfExtractionResponse(sparse);
    expect(result.accounts[0].accountNumber).toBe("");
    expect(result.accounts[0].positions).toEqual([]);
  });

  it("accepts null costBasis for a retirement fund position", () => {
    const retirement = JSON.stringify({
      asOfDate: "2026-09-01",
      accounts: [
        {
          accountName: "Verizon Mid-Atlantic 401k",
          accountNumber: "90274",
          positions: [
            {
              symbol: "VZ STOCK FUND",
              name: "VERIZON STOCK F",
              quantity: 10,
              lastPrice: 40,
              currentValue: 400,
              costBasis: null,
              gainLoss: null,
              gainLossPercent: null,
              percentOfAccount: 100,
            },
          ],
        },
      ],
    });
    const result = parsePdfExtractionResponse(retirement);
    expect(result.accounts[0].positions[0].costBasis).toBeNull();
  });

  it("coerces formatted-string numbers from the expanded 'My View' columns", () => {
    const formatted = JSON.stringify({
      asOfDate: "2026-09-01",
      accounts: [
        {
          accountName: "Gifts and Trips",
          accountNumber: "Z98765432",
          positions: [
            {
              symbol: "CASH",
              name: "FDIC-INSURED DEPOSIT SWEEP",
              quantity: "0",
              lastPrice: null,
              currentValue: "$2.13",
              costBasis: "$2.13",
              gainLoss: "0",
              gainLossPercent: "0",
              percentOfAccount: "100",
            },
          ],
        },
      ],
    });
    const result = parsePdfExtractionResponse(formatted);
    const [position] = result.accounts[0].positions;
    expect(position.currentValue).toBe(2.13);
    expect(position.costBasis).toBe(2.13);
    expect(position.quantity).toBe(0);
  });

  it("throws when a position is missing required fields", () => {
    const malformed = JSON.stringify({
      asOfDate: "2026-09-01",
      accounts: [
        { accountName: "X", accountNumber: "1", positions: [{ symbol: "AAPL" }] },
      ],
    });
    expect(() => parsePdfExtractionResponse(malformed)).toThrow(/malformed accounts list/);
  });
});

describe("pdfPositionsToHoldingRows", () => {
  it("returns an empty rows array for a cash-only account with zero positions", () => {
    expect(pdfPositionsToHoldingRows([])).toEqual([]);
  });

  it("filters out Verizon LTI Plan rows", () => {
    const rows = pdfPositionsToHoldingRows([
      {
        symbol: "VZ",
        name: "VERIZON LTI PLAN RSU",
        quantity: 10,
        lastPrice: 40,
        currentValue: 400,
        costBasis: null,
        gainLoss: null,
        gainLossPercent: null,
        percentOfAccount: 100,
      },
    ]);
    expect(rows).toHaveLength(0);
  });
});
