import { prisma } from "@/lib/prisma";
import { fetchSectorHoldings } from "@/lib/agents/sectorHoldings";

export interface SectorUniverse {
  sectorEtf: string;
  symbols: string[];
}

/** How many top-weighted holdings to keep per sector fund — SSGA already sorts by weight descending. A fund with fewer constituents than this (e.g. XLE, ~21 after filtering non-equity rows) contributes its full list rather than being padded. */
const TOP_N_HOLDINGS = 30;

/**
 * Sectors whose candidate universe is refreshed monthly from official SPDR
 * fund holdings (see refreshCandidateUniverse below), replacing what used to
 * be a hand-picked hardcoded list. Add a sector here to bring it under the
 * automated refresh; sectors not listed here keep using the static list in
 * candidateScanner.ts's STATIC_CANDIDATE_UNIVERSE.
 */
export const DYNAMIC_SECTORS: Array<{ sector: string; sectorEtf: string }> = [
  { sector: "Energy", sectorEtf: "XLE" },
  { sector: "Healthcare", sectorEtf: "XLV" },
  { sector: "Technology", sectorEtf: "XLK" },
];

/**
 * Reads the current DB-backed candidate universe for the dynamic sectors.
 * Sectors with no cached row yet (e.g. before the first refresh has run)
 * are simply absent from the returned map, same as an unrecognized sector
 * in the static list.
 */
export async function getDynamicCandidateUniverse(): Promise<Record<string, SectorUniverse>> {
  const rows = await prisma.candidateUniverse.findMany({
    where: { sector: { in: DYNAMIC_SECTORS.map((s) => s.sector) } },
  });
  const universe: Record<string, SectorUniverse> = {};
  for (const row of rows) {
    universe[row.sector] = { sectorEtf: row.sectorEtf, symbols: row.symbols as string[] };
  }
  return universe;
}

export interface UniverseRefreshResult {
  sector: string;
  sectorEtf: string;
  asOf: string;
  oldSymbols: string[];
  newSymbols: string[];
  added: string[];
  removed: string[];
}

/**
 * Pulls the current top-30-by-weight holdings for each dynamic sector's SPDR
 * fund directly from SSGA, diffs against what's cached in CandidateUniverse,
 * and upserts the fresh list. Meant to run monthly (see
 * app/api/cron/refresh-candidate-universe/route.ts via
 * runAndPersistCandidateUniverseRefresh in runner.ts). Logs each sector's
 * before/after counts and the added/removed symbols for audit purposes, in
 * addition to the AgentRun record the caller persists.
 */
export async function refreshCandidateUniverse(): Promise<UniverseRefreshResult[]> {
  const results: UniverseRefreshResult[] = [];

  for (const { sector, sectorEtf } of DYNAMIC_SECTORS) {
    const holdings = await fetchSectorHoldings(sectorEtf);
    const newSymbols = holdings.slice(0, TOP_N_HOLDINGS).map((h) => h.symbol);

    const existing = await prisma.candidateUniverse.findUnique({ where: { sector } });
    const oldSymbols = existing ? (existing.symbols as string[]) : [];

    const oldSet = new Set(oldSymbols);
    const newSet = new Set(newSymbols);
    const added = newSymbols.filter((s) => !oldSet.has(s));
    const removed = oldSymbols.filter((s) => !newSet.has(s));
    const asOf = new Date();

    await prisma.candidateUniverse.upsert({
      where: { sector },
      create: { sector, sectorEtf, symbols: newSymbols, asOf },
      update: { sectorEtf, symbols: newSymbols, asOf },
    });

    results.push({ sector, sectorEtf, asOf: asOf.toISOString(), oldSymbols, newSymbols, added, removed });

    console.log(
      `[candidate-universe-refresh] ${asOf.toISOString()} ${sector} (${sectorEtf}): ` +
        `${oldSymbols.length} -> ${newSymbols.length} symbols` +
        (added.length ? `; added [${added.join(", ")}]` : "") +
        (removed.length ? `; removed [${removed.join(", ")}]` : ""),
    );
  }

  return results;
}
