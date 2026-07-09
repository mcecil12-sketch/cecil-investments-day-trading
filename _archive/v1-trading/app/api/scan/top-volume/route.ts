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
const DEFAULT_LIMIT = 200;
const DEFAULT_VOLUME_MULTIPLIER = 3;

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

function detectVolumeSpike(bars: any[], multiplier: number): boolean {
  if (!bars || bars.length < 5) return false;
  const lastVol = bars[bars.length - 1].v ?? 0;
  const prior = bars.slice(0, -1);
  const avgPrior =
    prior.reduce((sum: number, b: any) => sum + (b.v ?? 0), 0) / prior.length || 0;
  return avgPrior > 0 && lastVol >= avgPrior * multiplier;
}

function buildSignal(symbol: string, bars: any[]) {
  const last = bars[bars.length - 1];
  const lastClose = last.c;
  // Simple up/down based on last two closes
  const prevClose = bars[bars.length - 2]?.c ?? lastClose;
  const side = lastClose >= prevClose ? "LONG" : "SHORT";

  const entry = lastClose;
  const stop = side === "LONG" ? entry * 0.99 : entry * 1.01;
  const target = side === "LONG" ? entry * 1.02 : entry * 0.98;

  return {
    id: randomUUID(),
    ticker: symbol,
    side,
    entryPrice: entry,
    stopPrice: stop,
    targetPrice: target,
    timeframe: "1Min",
    source: "TOP_VOLUME_SCAN",
    createdAt: new Date().toISOString(),
    rawMeta: {
      volumeSpike: true,
    },
  };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get("limit") ?? `${DEFAULT_LIMIT}`, 10);
    const minPrice = parseFloat(url.searchParams.get("minPrice") ?? `${DEFAULT_MIN_PRICE}`);
    const minVolume = parseFloat(url.searchParams.get("minVolume") ?? `${DEFAULT_MIN_AVG_VOL}`);
    const barsPerSymbol = parseInt(url.searchParams.get("bars") ?? `${DEFAULT_BARS}`, 10);
    const volumeMultiplier = parseFloat(
      url.searchParams.get("volumeMultiplier") ?? `${DEFAULT_VOLUME_MULTIPLIER}`
    );

    const assets = await getActiveUsEquityAssetsCached();
    const universe = assets.map((a: any) => a.symbol);
    const symbols = universe.slice(0, Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT);

    let postedCount = 0;
    let checked = 0;

    for (const symbol of symbols) {
      try {
        const bars = await fetchRecentBars(symbol, "1Min", barsPerSymbol);
        if (!bars || bars.length === 0) continue;
        checked += 1;

        // Price/volume prefilters
        const avgVol =
          bars.reduce((sum: number, b: any) => sum + b.v, 0) / bars.length;
        if (avgVol < minVolume) continue;

        const lastClose = bars[bars.length - 1].c;
        if (lastClose < minPrice) continue;

        if (!detectVolumeSpike(bars, volumeMultiplier)) continue;

        const signal = buildSignal(symbol, bars);
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
        console.error("[top-volume scan] error for", symbol, err);
      }
    }

    return NextResponse.json({
      status: "ok",
      mode: "top_volume",
      universeSize: symbols.length,
      checked,
      signalsPosted: postedCount,
    });
  } catch (err) {
    console.error("[top-volume scan] fatal error", err);
    return NextResponse.json(
      { status: "error", message: "Top volume scan failed" },
      { status: 500 }
    );
  }
}
