import { describe, expect, it } from "vitest";
import {
  isPlausibleVzLtiAsOfDate,
  mergeVzLtiTranches,
  parseGrantYear,
  parseVzLtiExtractionResponse,
} from "@/lib/portfolio/vzLtiImport";

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

describe("isPlausibleVzLtiAsOfDate", () => {
  const now = new Date("2026-09-07T00:00:00.000Z");

  it("accepts today's date", () => {
    expect(isPlausibleVzLtiAsOfDate(new Date("2026-09-07T00:00:00.000Z"), now)).toBe(true);
  });

  it("accepts a date within the drift window", () => {
    expect(isPlausibleVzLtiAsOfDate(new Date("2026-08-20T00:00:00.000Z"), now)).toBe(true);
  });

  it("rejects a misread year far in the past (the 2020-vs-2026 bug)", () => {
    expect(isPlausibleVzLtiAsOfDate(new Date("2020-09-07T00:00:00.000Z"), now)).toBe(false);
  });

  it("rejects a date far in the future", () => {
    expect(isPlausibleVzLtiAsOfDate(new Date("2027-09-07T00:00:00.000Z"), now)).toBe(false);
  });

  it("rejects an invalid date", () => {
    expect(isPlausibleVzLtiAsOfDate(new Date("not-a-date"), now)).toBe(false);
  });
});

describe("mergeVzLtiTranches", () => {
  it("de-dupes an identical tranche shown on two overlapping screenshots", () => {
    const screenshot1 = [
      { cohortLabel: "RD24", vestDate: "2027-03-01", shares: 1653.52 },
      { cohortLabel: "RD25", vestDate: "2027-03-01", shares: 1448.02 },
      { cohortLabel: "RD25", vestDate: "2028-03-01", shares: 1447.97 },
    ];
    const screenshot2 = [
      { cohortLabel: "RD25", vestDate: "2028-03-01", shares: 1447.97 },
      { cohortLabel: "RD26", vestDate: "2028-03-01", shares: 1216.27 },
      { cohortLabel: "RD26", vestDate: "2029-03-01", shares: 1217.3 },
    ];

    const { tranches, conflicts } = mergeVzLtiTranches([screenshot1, screenshot2]);
    expect(conflicts).toHaveLength(0);
    expect(tranches).toHaveLength(5);
    const totalShares = tranches.reduce((sum, t) => sum + t.shares, 0);
    expect(totalShares).toBeCloseTo(1653.52 + 1448.02 + 1447.97 + 1216.27 + 1217.3, 2);
  });

  it("flags a conflict instead of silently picking a value when share counts disagree", () => {
    const screenshot1 = [{ cohortLabel: "RD25", vestDate: "2028-03-01", shares: 1447.97 }];
    const screenshot2 = [{ cohortLabel: "RD25", vestDate: "2028-03-01", shares: 1400.0 }];

    const { tranches, conflicts } = mergeVzLtiTranches([screenshot1, screenshot2]);
    expect(tranches).toHaveLength(0);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ cohortLabel: "RD25", vestDate: "2028-03-01", shareValues: [1447.97, 1400.0] });
  });

  it("treats sub-cent differences as the same value, not a conflict", () => {
    const screenshot1 = [{ cohortLabel: "RD26", vestDate: "2029-03-01", shares: 1217.3 }];
    const screenshot2 = [{ cohortLabel: "RD26", vestDate: "2029-03-01", shares: 1217.301 }];

    const { tranches, conflicts } = mergeVzLtiTranches([screenshot1, screenshot2]);
    expect(conflicts).toHaveLength(0);
    expect(tranches).toHaveLength(1);
  });
});
