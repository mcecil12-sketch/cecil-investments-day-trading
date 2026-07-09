import { describe, expect, it } from "vitest";
import { isLockedInstrument } from "@/lib/benchmark/lockedHoldings";

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
