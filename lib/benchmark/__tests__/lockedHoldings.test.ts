import { describe, expect, it } from "vitest";
import { isLockedInstrument, isVerizonStockExposure } from "@/lib/benchmark/lockedHoldings";

describe("isLockedInstrument", () => {
  it("matches on instrument name, case-insensitively", () => {
    expect(isLockedInstrument({ symbol: "VZSTK", name: "Verizon Stock Fund" })).toBe(true);
    expect(isLockedInstrument({ symbol: "VZSTK", name: "VERIZON STOCK FUND" })).toBe(true);
  });

  it("matches on symbol when the label lives there instead", () => {
    expect(isLockedInstrument({ symbol: "VERIZON STOCK FUND", name: null })).toBe(true);
  });

  it("does not match unrelated instruments", () => {
    expect(isLockedInstrument({ symbol: "FXAIX", name: "FIDELITY 500 INDEX FUND" })).toBe(false);
    expect(isLockedInstrument({ symbol: "VZ", name: "Verizon Communications Inc" })).toBe(false);
  });
});

describe("isVerizonStockExposure", () => {
  it("matches everything isLockedInstrument matches", () => {
    expect(isVerizonStockExposure({ symbol: "VZSTK", name: "Verizon Stock Fund" })).toBe(true);
    expect(isVerizonStockExposure({ symbol: "VERIZON STOCK FUND", name: null })).toBe(true);
  });

  it("also matches real VZ common stock, case-insensitively", () => {
    expect(isVerizonStockExposure({ symbol: "VZ", name: "Verizon Communications Inc" })).toBe(true);
    expect(isVerizonStockExposure({ symbol: "vz", name: null })).toBe(true);
  });

  it("does not match unrelated instruments", () => {
    expect(isVerizonStockExposure({ symbol: "FXAIX", name: "FIDELITY 500 INDEX FUND" })).toBe(false);
    expect(isVerizonStockExposure({ symbol: "T", name: "AT&T Inc" })).toBe(false);
  });
});
