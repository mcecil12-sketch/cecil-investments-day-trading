import { AlpacaBar } from "@/lib/alpaca";

export type ScannerAssetLike = {
  symbol?: string;
  status?: string;
  tradable?: boolean;
  class?: string;
  asset_class?: string;
  name?: string;
  attributes?: string[];
};

function hasInvalidSymbolPunctuation(symbol: string): boolean {
  // Allow only letters and a single class separator dot, e.g. BRK.B / BF.B
  if (!/^[A-Z.]+$/.test(symbol)) return true;
  if (symbol.includes("/") || symbol.includes("^")) return true;
  const dotCount = (symbol.match(/\./g) || []).length;
  if (dotCount > 1) return true;
  if (dotCount === 1 && !/^[A-Z]{1,5}\.[A-Z]$/.test(symbol)) return true;
  return false;
}

export function getNonTradableInstrumentReason(
  rawSymbol: string,
  asset?: ScannerAssetLike
): string | null {
  const symbol = String(rawSymbol || "").trim().toUpperCase();
  if (!symbol) return "empty_symbol";

  // Preferred share style suffixes
  if (symbol.includes(".PR") || symbol.includes(".PRE") || symbol.includes(".PRI")) {
    return "preferred";
  }

  // Hard invalid symbol notation
  if (hasInvalidSymbolPunctuation(symbol)) {
    return "invalid_punctuation";
  }

  // Metadata-first filtering when asset is available
  if (asset) {
    const status = String(asset.status || "").toLowerCase();
    const tradable = asset.tradable === true;
    const assetClass = String(asset.asset_class || asset.class || "").toLowerCase();
    if (!tradable) return "not_tradable";
    if (status !== "active") return "inactive";
    if (assetClass !== "us_equity") return "non_us_equity";

    const metaText = [
      String(asset.name || ""),
      ...(Array.isArray(asset.attributes) ? asset.attributes.map((x) => String(x)) : []),
    ]
      .join(" ")
      .toLowerCase();

    if (/preferred/.test(metaText)) return "preferred";
    if (/warrant/.test(metaText)) return "warrant";
    if (/\bunit\b|units/.test(metaText)) return "unit";
    if (/\bright\b|rights/.test(metaText)) return "rights";
    if (/\bnote\b|\bnotes\b/.test(metaText)) return "note";
    if (/\bbond\b|\bbonds\b/.test(metaText)) return "bond";

    // With clean metadata, keep valid common stocks/classes (e.g. BRK.B, BF.B)
    return null;
  }

  // Fallback symbol-only heuristic when metadata is unavailable
  if (symbol.endsWith("WS") || symbol.endsWith("W")) return "warrant";
  if (symbol.endsWith("U")) return "unit";
  if (symbol.endsWith("R")) return "rights";

  return null;
}

export function isTradableCommonInstrument(
  symbol: string,
  asset?: ScannerAssetLike
): boolean {
  return getNonTradableInstrumentReason(symbol, asset) === null;
}

/**
 * Compute VWAP from an array of bars.
 * Uses typical price (H+L+C)/3 * volume.
 */
export function computeVWAP(bars: AlpacaBar[]): number {
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

/**
 * Placeholder: determine if symbol/asset is in a strong sector.
 * TODO: wire to real sector/industry data and market breadth signals.
 */
export function isStrongSector(_symbolOrAsset: any): boolean {
  // Stub: always false for now
  return false;
}

/**
 * Simple breakout heuristic: last close above prior N highs.
 * Default N = 20 bars (approx. 1 trading month on 1D; adjust per timeframe).
 */
export function isBreakout(bars: AlpacaBar[], lookback: number = 20): boolean {
  if (!bars || bars.length < lookback + 1) return false;
  const last = bars[bars.length - 1].c;
  const priorHigh = Math.max(
    ...bars.slice(-lookback - 1, -1).map((b) => b.h ?? b.c ?? 0)
  );
  return last > priorHigh;
}

/**
 * Simple compression heuristic (NR7-style):
 * Returns true if the last bar's range is the smallest of the last N bars.
 */
export function isCompression(bars: AlpacaBar[], lookback: number = 7): boolean {
  if (!bars || bars.length < lookback) return false;
  const recent = bars.slice(-lookback);
  const ranges = recent.map((b) => (b.h - b.l));
  const lastRange = ranges[ranges.length - 1];
  const minRange = Math.min(...ranges);
  return lastRange <= minRange;
}

/**
 * Volume gainer heuristic: current bar volume vs average of prior N bars.
 */
export function isTopVolumeGainer(
  bars: AlpacaBar[],
  multiplier: number = 2
): boolean {
  if (!bars || bars.length < 2) return false;
  const lastVol = bars[bars.length - 1].v ?? 0;
  const prior = bars.slice(0, -1);
  const avgPrior =
    prior.reduce((sum, b) => sum + (b.v ?? 0), 0) / prior.length || 0;
  return avgPrior > 0 && lastVol >= avgPrior * multiplier;
}

/**
 * Compute heuristic direction based on price relative to VWAP and trend.
 * - If price is below VWAP and trend is up => LONG pullback
 * - If price is above VWAP and trend is down => SHORT pullback
 * Returns null if unclear or no strong signal.
 */
export function computeDirection(params: {
  price: number;
  vwap: number | null;
  trend: "UP" | "DOWN" | "FLAT";
}): "LONG" | "SHORT" | null {
  const { price, vwap, trend } = params;
  
  if (!vwap || vwap <= 0 || !price || price <= 0) {
    return null;
  }
  
  const distancePct = ((price - vwap) / vwap) * 100;
  
  // LONG pullback: price below VWAP (pullback) in uptrend
  if (distancePct < -0.2 && trend === "UP") {
    return "LONG";
  }
  
  // SHORT pullback: price above VWAP (rejection) in downtrend
  if (distancePct > 0.2 && trend === "DOWN") {
    return "SHORT";
  }
  
  // Default: if clear uptrend => LONG bias, downtrend => SHORT bias
  if (trend === "UP") return "LONG";
  if (trend === "DOWN") return "SHORT";
  
  return null;
}

// Basic signal shape for scanners to reuse
export type BasicSignalInput = {
  ticker: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  timeframe?: string;
  source?: string;
  createdAt?: string;
  meta?: Record<string, any>;
};
