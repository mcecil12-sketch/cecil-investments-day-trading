import { describe, expect, it } from "vitest";
import { parseGrantYear, parseVzLtiExtractionResponse } from "@/lib/portfolio/vzLtiImport";

describe("parseGrantYear", () => {
  it("parses 2-digit cohort labels as 20xx", () => {
    expect(parseGrantYear("RD24")).toBe(2024);
    expect(parseGrantYear("RD25")).toBe(2025);
    expect(parseGrantYear("RD26")).toBe(2026);
  });

  it("parses a 4-digit year as-is", () => {
    expect(parseGrantYear("RD2024")).toBe(2024);
  });

  it("returns null for a label with no trailing digits", () => {
    expect(parseGrantYear("RD")).toBeNull();
  });
});

describe("parseVzLtiExtractionResponse", () => {
  it("parses the real Stock Plans example data (RD24/RD25/RD26)", () => {
    const response = JSON.stringify({
      asOfDate: "2026-09-03",
      tranches: [
        { cohortLabel: "RD24", vestDate: "2027-03-01", shares: 1653.52 },
        { cohortLabel: "RD25", vestDate: "2027-03-01", shares: 1448.02 },
        { cohortLabel: "RD25", vestDate: "2028-03-01", shares: 1447.97 },
        { cohortLabel: "RD26", vestDate: "2027-03-01", shares: 1216.27 },
        { cohortLabel: "RD26", vestDate: "2028-03-01", shares: 1216.27 },
        { cohortLabel: "RD26", vestDate: "2029-03-01", shares: 1217.3 },
      ],
    });

    const result = parseVzLtiExtractionResponse(response);
    expect(result.asOfDate).toBe("2026-09-03");
    expect(result.tranches).toHaveLength(6);
    const totalShares = result.tranches.reduce((sum, t) => sum + t.shares, 0);
    expect(totalShares).toBeCloseTo(8199.35, 2);
  });

  it("strips a markdown fence if present", () => {
    const response = "```json\n" + JSON.stringify({ asOfDate: "2026-09-03", tranches: [{ cohortLabel: "RD24", vestDate: "2027-03-01", shares: 1 }] }) + "\n```";
    expect(() => parseVzLtiExtractionResponse(response)).not.toThrow();
  });

  it("throws on an empty tranches list", () => {
    const response = JSON.stringify({ asOfDate: "2026-09-03", tranches: [] });
    expect(() => parseVzLtiExtractionResponse(response)).toThrow(/malformed or empty/);
  });

  it("throws when a cohort label has no parseable grant year", () => {
    const response = JSON.stringify({ asOfDate: "2026-09-03", tranches: [{ cohortLabel: "RD", vestDate: "2027-03-01", shares: 1 }] });
    expect(() => parseVzLtiExtractionResponse(response)).toThrow(/grant year/);
  });

  it("throws on missing asOfDate", () => {
    const response = JSON.stringify({ tranches: [{ cohortLabel: "RD24", vestDate: "2027-03-01", shares: 1 }] });
    expect(() => parseVzLtiExtractionResponse(response)).toThrow(/asOfDate/);
  });
});
