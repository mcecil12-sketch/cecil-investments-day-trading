import { NextResponse } from "next/server";
import { fetchRecentBars } from "@/lib/alpaca";
import { getAlpacaClient } from "@/lib/alpacaClient";
import { randomUUID } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const DEFAULT_MIN_PRICE = 10;
const DEFAULT_MIN_AVG_VOL = 2_000_000;
const DEFAULT_BARS = 60;
const DEFAULT_PER_SECTOR = 8;

type CachedAssets = {
  assets: any[];
  fetchedAt: number;
};

let ASSET_CACHE: CachedAssets | null = null;
const ASSET_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h

async function getActiveUsEquityAssetsCached(): Promise<any[]> {
  const now = Date.now();
  if (ASSET_CACHE && now - ASSET_CACHE.fetchedAt < ASSET_CACHE_TTL_MS) {
    return ASSET_CACHE.assets;
  }

  const client = getAlpacaClient();
  const assets = await client.getAssets();
  const filtered = assets.filter(
    (a: any) =>
      a.status === "active" &&
      (a.class ?? a.asset_class ?? "").toLowerCase() === "us_equity" &&
      a.tradable
  );

  ASSET_CACHE = {
    assets: filtered,
    fetchedAt: now,
  };

  return filtered;
}

// VWAP helper
function computeVWAP(bars: any[]): number {
  if (!bars || bars.length === 0) return 0;
  let sumPV = 0;
  let sumVol = 0;
  for (const b of bars) {
    const tp = (b.h + b.l + b.c) / 3;
    const vol = b.v ?? 0;
    sumPV += tp * vol;
    sumVol += vol;
  }
  return sumVol ? sumPV / sumVol : bars[bars.length - 1]?.c ?? 0;
}

function detectPullback(symbol: string, bars: any[]) {
  if (!bars || bars.length < 10) return null;

  const vwap = computeVWAP(bars);
  const last = bars[bars.length - 1];
  const lastClose = last.c;
  const distancePct = Math.abs(lastClose - vwap) / vwap;
  if (distancePct > 0.004) return null;

  const side = lastClose > vwap ? "LONG" : "SHORT";
  const entry = lastClose;
  const stop = side === "LONG" ? entry * 0.992 : entry * 1.008;
  const target = side === "LONG" ? entry * 1.016 : entry * 0.984;

  return {
    id: randomUUID(),
    ticker: symbol,
    side,
    entryPrice: entry,
    stopPrice: stop,
    targetPrice: target,
    timeframe: "1Min",
    source: "SECTOR_CLUSTER_SCAN",
    createdAt: new Date().toISOString(),
    rawMeta: {
      vwap,
      pullbackPct: distancePct * 100,
    },
  };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const minPrice = parseFloat(url.searchParams.get("minPrice") ?? `${DEFAULT_MIN_PRICE}`);
    const minVolume = parseFloat(url.searchParams.get("minVolume") ?? `${DEFAULT_MIN_AVG_VOL}`);
    const barsPerSymbol = parseInt(url.searchParams.get("bars") ?? `${DEFAULT_BARS}`, 10);
    const perSector = parseInt(
      url.searchParams.get("perSector") ?? `${DEFAULT_PER_SECTOR}`,
      10
    );

    const assets = await getActiveUsEquityAssetsCached();

    // If no sector info, bail with 501 to avoid silent failures
    const hasSector = assets.some((a: any) => a.sector || a.industry);
    if (!hasSector) {
      return NextResponse.json(
        { status: "unsupported", reason: "Sector data unavailable in Alpaca assets" },
        { status: 501 }
      );
    }

    // Group by sector (fall back to industry if sector missing)
    const sectorMap = new Map<string, any[]>();
    for (const a of assets) {
      const sector = (a.sector || a.industry || "UNKNOWN") as string;
      if (!sectorMap.has(sector)) {
        sectorMap.set(sector, []);
      }
      sectorMap.get(sector)?.push(a);
    }

    // Rank sectors by simple count (placeholder for real strength metrics)
    const rankedSectors = Array.from(sectorMap.entries()).sort(
      (a, b) => (b[1]?.length ?? 0) - (a[1]?.length ?? 0)
    );

    // Take top 3 sectors (configurable later)
    const topSectors = rankedSectors.slice(0, 3);

    const symbols: string[] = [];
    for (const [, list] of topSectors) {
      const pick = list.slice(0, perSector).map((a: any) => a.symbol);
      symbols.push(...pick);
    }

    let postedCount = 0;
    const sectorsChecked = topSectors.map((s) => s[0]);

    for (const symbol of symbols) {
      try {
        const bars = await fetchRecentBars(symbol, "1Min", barsPerSymbol);
        if (!bars || bars.length === 0) continue;

        const avgVol =
          bars.reduce((sum: number, b: any) => sum + b.v, 0) / bars.length;
        if (avgVol < minVolume) continue;

        const lastClose = bars[bars.length - 1].c;
        if (lastClose < minPrice) continue;

        const signal = detectPullback(symbol, bars);
        if (!signal) continue;

        await fetch(
          `${process.env.NEXT_PUBLIC_BASE_URL ?? "http://127.0.0.1:3000"}/api/signals`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(signal),
          }
        );
        postedCount += 1;
      } catch (err) {
        console.error("[sector scan] error for", symbol, err);
      }
    }

    return NextResponse.json({
      status: "ok",
      mode: "sector_cluster",
      sectorsChecked,
      signalsPosted: postedCount,
    });
  } catch (err) {
    console.error("[sector scan] fatal error", err);
    return NextResponse.json(
      { status: "error", message: "Sector scan failed" },
      { status: 500 }
    );
  }
}
