import { NextResponse } from "next/server";
import { fetchRecentBars } from "@/lib/alpaca";
import { getAlpacaClient } from "@/lib/alpacaClient";
import { isCompression } from "@/lib/scannerUtils";
import { randomUUID } from "crypto";

export const runtime = "nodejs";

const DEFAULT_LIMIT = 150;
const DEFAULT_MIN_PRICE = 10;
const DEFAULT_MIN_AVG_VOL = 2_000_000;
const DEFAULT_BARS = 60;
const DEFAULT_TIMEFRAME = "15Min";

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

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get("limit") ?? `${DEFAULT_LIMIT}`, 10);
    const minPrice = parseFloat(url.searchParams.get("minPrice") ?? `${DEFAULT_MIN_PRICE}`);
    const minVolume = parseFloat(url.searchParams.get("minVolume") ?? `${DEFAULT_MIN_AVG_VOL}`);
    const barsPerSymbol = parseInt(url.searchParams.get("bars") ?? `${DEFAULT_BARS}`, 10);
    const timeframe = url.searchParams.get("timeframe") ?? DEFAULT_TIMEFRAME;
    const lookback = parseInt(url.searchParams.get("lookback") ?? "7", 10);

    const assets = await getActiveUsEquityAssetsCached();
    const symbols = assets
      .map((a: any) => a.symbol)
      .slice(0, Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT);

    let posted: string[] = [];
    let checked = 0;

    for (const symbol of symbols) {
      try {
        const bars = await fetchRecentBars(symbol, timeframe, barsPerSymbol);
        if (!bars || bars.length === 0) continue;
        checked += 1;

        const avgVol =
          bars.reduce((sum: number, b: any) => sum + b.v, 0) / bars.length;
        if (avgVol < minVolume) continue;

        const lastClose = bars[bars.length - 1].c;
        if (lastClose < minPrice) continue;

        if (!isCompression(bars, lookback)) continue;

        // Neutral bias; you could refine with trend check
        const entry = lastClose;
        const stop = entry * 0.99;
        const target = entry * 1.02;

        const signal = {
          id: randomUUID(),
          ticker: symbol,
          side: "LONG",
          entryPrice: entry,
          stopPrice: stop,
          targetPrice: target,
          timeframe,
          source: "COMPRESSION_SCAN",
          createdAt: new Date().toISOString(),
          rawMeta: {
            compression: true,
            lookback,
          },
        };

        await fetch(
          `${process.env.NEXT_PUBLIC_BASE_URL ?? "http://127.0.0.1:3000"}/api/signals`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(signal),
          }
        );
        posted.push(symbol);
      } catch (err) {
        console.error("[compression scan] error for", symbol, err);
      }
    }

    return NextResponse.json({
      status: "ok",
      mode: "compression_scan",
      universeSize: symbols.length,
      checked,
      signalsPosted: posted.length,
      tickersPosted: posted,
    });
  } catch (err) {
    console.error("[compression scan] fatal error", err);
    return NextResponse.json(
      { status: "error", message: "Compression scan failed" },
      { status: 500 }
    );
  }
}
