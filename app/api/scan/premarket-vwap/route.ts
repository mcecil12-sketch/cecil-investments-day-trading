import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { getAlpacaClient } from "@/lib/alpacaClient";
import type { AlpacaBar } from "@/lib/alpaca";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const DEFAULT_LIMIT = 150;
const DEFAULT_MIN_PRICE = 10;
const DEFAULT_MIN_AVG_VOL = 500_000;
const DEFAULT_BARS = 60;
const DEFAULT_PREMARKET_MINUTES = 120; // last 2 hours by default

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

function alpacaDataBaseUrl() {
  return (
    process.env.ALPACA_DATA_BASE_URL ||
    process.env.ALPACA_DATA_URL ||
    "https://data.alpaca.markets/v2"
  );
}

function alpacaHeaders() {
  const key =
    process.env.ALPACA_API_KEY_ID ||
    process.env.ALPACA_KEY_ID ||
    process.env.ALPACA_API_KEY ||
    "";
  const secret =
    process.env.ALPACA_API_SECRET_KEY ||
    process.env.ALPACA_SECRET_KEY ||
    process.env.ALPACA_API_SECRET ||
    "";
  if (!key || !secret) {
    throw new Error("Missing Alpaca API credentials");
  }
  return {
    "APCA-API-KEY-ID": key,
    "APCA-API-SECRET-KEY": secret,
  };
}

async function fetchPremarketBars(
  symbol: string,
  timeframe: string,
  limit: number,
  startIso: string,
  endIso: string
): Promise<AlpacaBar[]> {
  const url = `${alpacaDataBaseUrl()}/stocks/${encodeURIComponent(
    symbol
  )}/bars?timeframe=${timeframe}&limit=${limit}&adjustment=all&start=${encodeURIComponent(
    startIso
  )}&end=${encodeURIComponent(endIso)}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      ...alpacaHeaders(),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[premarket scan] bars error", symbol, res.status, text);
    return [];
  }
  const json = await res.json();
  return json.bars ?? [];
}

function computeVWAP(bars: AlpacaBar[]): number {
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

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get("limit") ?? `${DEFAULT_LIMIT}`, 10);
    const minPrice = parseFloat(url.searchParams.get("minPrice") ?? `${DEFAULT_MIN_PRICE}`);
    const minVolume = parseFloat(url.searchParams.get("minVolume") ?? `${DEFAULT_MIN_AVG_VOL}`);
    const barsPerSymbol = parseInt(url.searchParams.get("bars") ?? `${DEFAULT_BARS}`, 10);
    const preMinutes = parseInt(
      url.searchParams.get("premarketMinutes") ?? `${DEFAULT_PREMARKET_MINUTES}`,
      10
    );
    const timeframe = url.searchParams.get("timeframe") ?? "1Min";

    const assets = await getActiveUsEquityAssetsCached();
    const symbols = assets
      .map((a: any) => a.symbol)
      .slice(0, Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_LIMIT);

    const end = new Date();
    const start = new Date(end.getTime() - preMinutes * 60_000);
    const startIso = start.toISOString();
    const endIso = end.toISOString();

    let checked = 0;
    let posted = 0;

    for (const symbol of symbols) {
      try {
        const bars = await fetchPremarketBars(symbol, timeframe, barsPerSymbol, startIso, endIso);
        if (!bars || bars.length === 0) continue;
        checked += 1;

        const avgVol =
          bars.reduce((sum: number, b: any) => sum + b.v, 0) / bars.length;
        if (avgVol < minVolume) continue;

        const lastClose = bars[bars.length - 1].c;
        if (lastClose < minPrice) continue;

        const vwap = computeVWAP(bars);
        const diffPct = Math.abs(lastClose - vwap) / (vwap || 1);

        const volumeSpike =
          avgVol > 0 &&
          (bars[bars.length - 1].v ?? 0) >= avgVol * 2;

        const nearVwap = diffPct <= 0.003;
        const breaking = diffPct >= 0.01 && volumeSpike;

        if (!nearVwap && !breaking) continue;

        const side = lastClose >= vwap ? "LONG" : "SHORT";
        const entry = lastClose;
        const stop = side === "LONG" ? entry * 0.995 : entry * 1.005;
        const target = side === "LONG" ? entry * 1.01 : entry * 0.99;

        const signal = {
          id: randomUUID(),
          ticker: symbol,
          side,
          entryPrice: entry,
          stopPrice: stop,
          targetPrice: target,
          timeframe,
          source: "PREMARKET_VWAP_SCAN",
          createdAt: new Date().toISOString(),
          rawMeta: {
            vwap,
            diffPct,
            volumeSpike,
            preMinutes,
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
        posted += 1;
      } catch (err) {
        console.error("[premarket vwap scan] error for", symbol, err);
      }
    }

    return NextResponse.json({
      status: "ok",
      mode: "premarket_vwap",
      universeSize: symbols.length,
      checked,
      signalsPosted: posted,
    });
  } catch (err) {
    console.error("[premarket vwap scan] fatal error", err);
    return NextResponse.json(
      { status: "error", message: "Premarket VWAP scan failed" },
      { status: 500 }
    );
  }
}
