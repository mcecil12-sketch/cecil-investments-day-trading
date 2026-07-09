import fs from "fs/promises";
import path from "path";
import { getAlpacaClient } from "@/lib/alpacaClient";

const CACHE_PATH = path.join(process.cwd(), "data", "universeCache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export type UniverseSymbol = {
  symbol: string;
  name?: string;
  exchange: string;
  class?: string;
  tradable?: boolean;
  fractionable?: boolean;
  status?: string;
};

// Load cached universe if younger than TTL
async function loadCachedUniverse(): Promise<UniverseSymbol[] | null> {
  try {
    const raw = await fs.readFile(CACHE_PATH, "utf8");
    const parsed = JSON.parse(raw);

    if (Date.now() - parsed.timestamp > CACHE_TTL_MS) {
      return null;
    }
    return parsed.universe;
  } catch {
    return null;
  }
}

// Save fresh universe
async function saveCachedUniverse(universe: UniverseSymbol[]) {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(
    CACHE_PATH,
    JSON.stringify({ timestamp: Date.now(), universe }, null, 2)
  );
}

export async function getUniverse({
  minPrice = 10,
  allowedExchanges = ["NASDAQ", "NYSE"],
  limit,
}: {
  minPrice?: number;
  allowedExchanges?: string[];
  limit?: number;
} = {}): Promise<string[]> {
  // Try cached first
  const cached = await loadCachedUniverse();
  let universe: UniverseSymbol[];

  if (cached) {
    universe = cached;
  } else {
    const alpaca = getAlpacaClient();
    const assets = await alpaca.getAssets();
    const filtered = assets.filter((a: any) => a.status === "active");
    universe = filtered.map((a: any) => ({
      symbol: a.symbol,
      exchange: a.exchange,
      tradable: a.tradable,
      fractionable: a.fractionable,
      status: a.status,
    }));
    await saveCachedUniverse(universe);
  }

  // Hard prefilter
  let symbols = universe.filter(
    (a) =>
      allowedExchanges.includes(a.exchange) &&
      a.tradable &&
      a.fractionable
  );

  // Note: minPrice is available only if you extend asset data with prices; kept for API symmetry
  if (limit) symbols = symbols.slice(0, limit);

  return symbols.map((u) => u.symbol);
}
