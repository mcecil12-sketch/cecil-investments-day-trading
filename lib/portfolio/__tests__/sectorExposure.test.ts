import { describe, expect, it } from "vitest";
import { sectorWeightsByValue, sectorWeightsEqual, UNKNOWN_SECTOR } from "@/lib/portfolio/sectorExposure";

describe("sectorWeightsEqual (top-10 variants)", () => {
  it("weights each name 1/N and sorts by weight", () => {
    const w = sectorWeightsEqual([
      { symbol: "A", sector: "Technology" },
      { symbol: "B", sector: "Technology" },
      { symbol: "C", sector: "Energy" },
      { symbol: "D", sector: "Energy" },
      { symbol: "E", sector: "Technology" },
    ]);
    expect(w.rows.map((r) => [r.sector, r.count, r.weight])).toEqual([["Technology", 3, 0.6], ["Energy", 2, 0.4]]);
    expect(w.unknownWeight).toBe(0);
  });

  it("marks unclassified names Unknown instead of guessing", () => {
    const w = sectorWeightsEqual([{ symbol: "A", sector: "Technology" }, { symbol: "ZZZ", sector: null }]);
    expect(w.rows.find((r) => r.sector === UNKNOWN_SECTOR)).toMatchObject({ count: 1, weight: 0.5, symbols: ["ZZZ"] });
    expect(w.unknownSymbols).toEqual(["ZZZ"]);
  });
});

describe("sectorWeightsByValue (unified portfolio)", () => {
  it("dollar-weights, including Verizon-linked holdings in their sector, and reports unknown separately", () => {
    const w = sectorWeightsByValue([
      { symbol: "VZ", value: 300, sector: "Communications" },
      { symbol: "VERIZON STOCK FUND", value: 100, sector: "Communications" },
      { symbol: "FXAIX", value: 400, sector: "Broad Market" },
      { symbol: "VERIZON 2070 FUND", value: 150, sector: null },
      { symbol: "BND", value: 50, sector: null },
      { symbol: "JUNK", value: 0, sector: "Energy" },
    ]);
    expect(w.total).toBe(1000);
    expect(w.rows[0]).toMatchObject({ sector: "Broad Market", value: 400, weight: 0.4 });
    expect(w.rows.find((r) => r.sector === "Communications")).toMatchObject({ value: 400, weight: 0.4, count: 2 });
    expect(w.unknownWeight).toBeCloseTo(0.2);
    expect(w.unknownSymbols).toEqual(["VERIZON 2070 FUND", "BND"]);
    expect(w.rows.find((r) => r.sector === "Energy")).toBeUndefined();
  });

  it("empty input is safe", () => {
    expect(sectorWeightsByValue([])).toMatchObject({ total: 0, rows: [], unknownWeight: 0 });
  });
});
