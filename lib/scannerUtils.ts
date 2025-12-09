import { AlpacaBar } from "@/lib/alpaca";

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
