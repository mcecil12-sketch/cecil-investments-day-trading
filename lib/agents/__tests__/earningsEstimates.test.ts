import { describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const findMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { agentRun: { findFirst }, earningsEstimateSnapshot: { findMany } },
}));

const getDynamicCandidateUniverse = vi.fn();
vi.mock("@/lib/agents/candidateUniverse", () => ({ getDynamicCandidateUniverse }));

const { selectSymbolsToFetch } = await import("@/lib/agents/earningsEstimates");
const { STATIC_CANDIDATE_UNIVERSE } = await import("@/lib/agents/candidateScanner");

function scannerRun(symbols: string[]) {
  return { output: { topCandidates: symbols.map((symbol) => ({ symbol })) } };
}

const staticSymbols = Object.values(STATIC_CANDIDATE_UNIVERSE).flatMap((sector) => sector.symbols);

describe("selectSymbolsToFetch", () => {
  it("pulls the latest Top 15 first, then the rest of the dynamic universe, before touching the static list", async () => {
    findFirst.mockResolvedValueOnce(scannerRun(["DELL", "PANW", "VLO"]));
    getDynamicCandidateUniverse.mockResolvedValueOnce({
      Technology: { sectorEtf: "XLK", symbols: ["DELL", "PANW", "VLO", "CRWD", "MU"] },
    });
    findMany.mockResolvedValueOnce([]); // nothing ever fetched

    const result = await selectSymbolsToFetch(4);
    expect(result).toEqual(["DELL", "PANW", "VLO", "CRWD"]);
  });

  it("falls back to the rest of the dynamic universe once the Top 15 tier is exhausted, without reaching the static tier", async () => {
    findFirst.mockResolvedValueOnce(scannerRun(["DELL"]));
    getDynamicCandidateUniverse.mockResolvedValueOnce({
      Technology: { sectorEtf: "XLK", symbols: ["DELL", "MU", "AMD"] },
    });
    findMany.mockResolvedValueOnce([]);

    const result = await selectSymbolsToFetch(3);
    expect(result).toEqual(["DELL", "MU", "AMD"]);
    expect(result.some((s) => staticSymbols.includes(s))).toBe(false);
  });

  it("reaches the static tier only once every dynamic-universe symbol is placed", async () => {
    findFirst.mockResolvedValueOnce(scannerRun(["DELL"]));
    getDynamicCandidateUniverse.mockResolvedValueOnce({
      Technology: { sectorEtf: "XLK", symbols: ["DELL", "MU"] },
    });
    findMany.mockResolvedValueOnce([]);

    const result = await selectSymbolsToFetch(3);
    expect(result[0]).toBe("DELL");
    expect(result[1]).toBe("MU");
    expect(staticSymbols).toContain(result[2]);
  });

  it("keeps never-fetched-first / oldest-fetched-first staleness ordering within a tier", async () => {
    findFirst.mockResolvedValueOnce(scannerRun(["AMD", "MU", "DELL"]));
    getDynamicCandidateUniverse.mockResolvedValueOnce({ Technology: { sectorEtf: "XLK", symbols: ["AMD", "MU", "DELL"] } });
    findMany.mockResolvedValueOnce([
      { symbol: "AMD", lastFetchedAt: new Date("2020-01-01") },
      { symbol: "MU", lastFetchedAt: new Date("2020-01-05") },
      // DELL never fetched (no row) -> should sort first
    ]);

    const result = await selectSymbolsToFetch(3);
    expect(result).toEqual(["DELL", "AMD", "MU"]);
  });

  it("a symbol in both the Top 15 and the dynamic universe only appears once, at its highest-priority slot", async () => {
    findFirst.mockResolvedValueOnce(scannerRun(["DELL"]));
    getDynamicCandidateUniverse.mockResolvedValueOnce({
      Technology: { sectorEtf: "XLK", symbols: ["DELL", "MU"] },
    });
    findMany.mockResolvedValueOnce([]);

    const result = await selectSymbolsToFetch(2);
    expect(result.filter((s) => s === "DELL")).toHaveLength(1);
    expect(result).toEqual(["DELL", "MU"]);
  });

  it("falls back to dynamic-then-static universe when no Candidate Scanner run has completed yet", async () => {
    findFirst.mockResolvedValueOnce(null);
    getDynamicCandidateUniverse.mockResolvedValueOnce({
      Technology: { sectorEtf: "XLK", symbols: ["MU"] },
    });
    findMany.mockResolvedValueOnce([]);

    const result = await selectSymbolsToFetch(2);
    expect(result[0]).toBe("MU");
    expect(staticSymbols).toContain(result[1]);
  });
});
