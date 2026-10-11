/**
 * Sector weights for the exposure view (display only). Holdings whose sector
 * cannot be determined from the app's existing classification are reported as
 * "Unknown" with their symbols — never guessed.
 */
export const UNKNOWN_SECTOR = "Unknown";

export interface SectorWeightRow {
  sector: string;
  /** Dollars (portfolio view) or null for equal-weight name lists. */
  value: number | null;
  count: number;
  weight: number;
  symbols: string[];
}

export interface SectorWeights {
  rows: SectorWeightRow[];
  total: number;
  /** Share of the total whose sector is unknown. */
  unknownWeight: number;
  unknownSymbols: string[];
}

function finish(map: Map<string, { value: number; count: number; symbols: string[] }>, total: number, valued: boolean): SectorWeights {
  const rows: SectorWeightRow[] = [...map.entries()]
    .map(([sector, v]) => ({ sector, value: valued ? v.value : null, count: v.count, weight: total > 0 ? v.value / total : 0, symbols: v.symbols }))
    .sort((a, b) => b.weight - a.weight || a.sector.localeCompare(b.sector));
  const unknown = rows.find((r) => r.sector === UNKNOWN_SECTOR);
  return { rows, total, unknownWeight: unknown?.weight ?? 0, unknownSymbols: unknown?.symbols ?? [] };
}

/** Equal-weight sector mix of a list of names (the top-10 variants): each name is 1/N. */
export function sectorWeightsEqual(names: Array<{ symbol: string; sector: string | null }>): SectorWeights {
  const map = new Map<string, { value: number; count: number; symbols: string[] }>();
  for (const n of names) {
    const key = n.sector ?? UNKNOWN_SECTOR;
    const e = map.get(key) ?? { value: 0, count: 0, symbols: [] };
    e.value += 1;
    e.count += 1;
    e.symbols.push(n.symbol);
    map.set(key, e);
  }
  return finish(map, names.length, false);
}

/** Dollar-weighted sector mix of holdings; zero/negative values are ignored. */
export function sectorWeightsByValue(holdings: Array<{ symbol: string; value: number; sector: string | null }>): SectorWeights {
  const map = new Map<string, { value: number; count: number; symbols: string[] }>();
  let total = 0;
  for (const h of holdings) {
    if (!(h.value > 0)) continue;
    total += h.value;
    const key = h.sector ?? UNKNOWN_SECTOR;
    const e = map.get(key) ?? { value: 0, count: 0, symbols: [] };
    e.value += h.value;
    e.count += 1;
    e.symbols.push(h.symbol);
    map.set(key, e);
  }
  return finish(map, total, true);
}
