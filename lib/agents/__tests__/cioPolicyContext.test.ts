import { describe, expect, it } from "vitest";
import { nextMonthlyScanDate } from "@/lib/agents/cioPolicyContext";
import { policyContextPrompt } from "@/lib/agents/cio";

describe("nextMonthlyScanDate", () => {
  it("returns the 1st of the following month", () => {
    expect(nextMonthlyScanDate(new Date("2026-10-18T16:00:00Z"))).toBe("2026-11-01");
  });
  it("rolls over the year in December", () => {
    expect(nextMonthlyScanDate(new Date("2026-12-15T12:00:00Z"))).toBe("2027-01-01");
  });
});

describe("policyContextPrompt", () => {
  it("carries the top 10, sell candidates and tradeable Verizon share", () => {
    const prompt = policyContextPrompt({
      group3: { batchTag: "monthly-2026-10", top10: ["DELL", "MRNA"], sellCandidates: ["PSX"], nextScanDate: "2026-11-01" },
      verizon: { includingLtiValue: 400883, includingLtiPct: 0.313, tradeableValue: 33634, tradeablePct: 0.037 },
    });
    expect(prompt).toContain("portfolioPolicy");
    expect(prompt).toContain("PSX");
    expect(prompt).toContain("tradeablePct");
    expect(prompt).toContain("2026-11-01");
  });
});
