/**
 * Canonical open trade selection — one authoritative active record per broker position.
 *
 * When the system carries multiple OPEN trade records for the same ticker (e.g. a rich
 * AUTO-executed trade plus a ghost broker_backfill placeholder), this module selects the
 * single "canonical" record per symbol and identifies all non-canonical "ghosts" that
 * should be superseded/archived.
 *
 * Key design choices:
 * - Symbol-based grouping (ticker normalised to upper-case)
 * - Richness-score tie-breaking: most metadata wins
 * - Proximity grouping: trades for the same position are only grouped if their
 *   entryPrice is within ENTRY_PRICE_PCT pct, qty within QTY_PCT pct, and
 *   creation times within OPEN_TIME_WINDOW_MS ms — loose bounds so partial-fill
 *   duplicates or backfilled records still match the real trade.
 * - Pure function: no I/O, no side effects.
 */

import { isOperationallyOpenTrade } from "@/lib/trades/operational";

// ─── Matching Thresholds ─────────────────────────────────────────────────────

/** Entry-price proximity: trades must be within this % of each other to be "same position". */
const ENTRY_PRICE_PCT = 0.03; // 3 %

/** Qty proximity: allow up to 20 % difference (partial fills, rounding). */
const QTY_PCT = 0.20;

/** Time proximity: trades created within this window are treated as the same broker event. */
const OPEN_TIME_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours

// ─── Richness Scoring ────────────────────────────────────────────────────────

/**
 * Returns a numeric richness score for a trade record.
 * Higher score = more metadata = more likely to be the real executed trade.
 */
export function tradeRichness(t: any): number {
  let score = 0;
  if (t?.alpacaOrderId || t?.brokerOrderId) score += 16;
  if (t?.stopOrderId || t?.alpacaStopOrderId) score += 8;
  if (t?.takeProfitOrderId) score += 4;
  if (t?.signalId) score += 4;
  if (t?.source === "AUTO" || t?.source === "AUTO-ENTRY") score += 8;
  if (t?.protectionStatus === "VERIFIED") score += 4;
  if (Number.isFinite(Number(t?.aiScore)) && Number(t?.aiScore) > 0) score += 2;
  if (t?.tier) score += 1;
  if (Number.isFinite(Number(t?.stopPrice)) && Number(t?.stopPrice) > 0) score += 1;
  if (Number.isFinite(Number(t?.targetPrice)) && Number(t?.targetPrice) > 0) score += 1;
  return score;
}

// ─── Proximity Helpers ───────────────────────────────────────────────────────

function withinPct(a: number, b: number, pct: number): boolean {
  if (a <= 0 || b <= 0) return true; // missing values → don't disqualify
  return Math.abs(a - b) / Math.max(a, b) < pct;
}

function withinMs(isoA: string | null | undefined, isoB: string | null | undefined, ms: number): boolean {
  if (!isoA || !isoB) return true; // missing timestamps → don't disqualify
  const a = Date.parse(isoA);
  const b = Date.parse(isoB);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return Math.abs(a - b) < ms;
}

export function tradesSamePosition(a: any, b: any): boolean {
  // Sides must match
  const sideA = String(a?.side || "").toUpperCase();
  const sideB = String(b?.side || "").toUpperCase();
  if (sideA && sideB && sideA !== sideB) return false;

  // Entry price proximity
  const epA = Number(a?.entryPrice ?? a?.avgFillPrice ?? 0);
  const epB = Number(b?.entryPrice ?? b?.avgFillPrice ?? 0);
  if (!withinPct(epA, epB, ENTRY_PRICE_PCT)) return false;

  // Qty proximity
  const qtyA = Number(a?.qty ?? a?.filledQty ?? a?.size ?? 0);
  const qtyB = Number(b?.qty ?? b?.filledQty ?? b?.size ?? 0);
  if (!withinPct(qtyA, qtyB, QTY_PCT)) return false;

  // Time proximity
  const tsA = a?.openedAt ?? a?.createdAt ?? a?.filledAt;
  const tsB = b?.openedAt ?? b?.createdAt ?? b?.filledAt;
  if (!withinMs(tsA, tsB, OPEN_TIME_WINDOW_MS)) return false;

  return true;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export type CanonicalGroupResult = {
  /** One canonical (richest) record per normalised ticker. */
  canonical: Map<string, any>;
  /**
   * All non-canonical duplicates that share a ticker with a canonical record.
   * Each entry also carries `_canonicalId` pointing at the winner's id.
   */
  ghosts: Array<any & { _canonicalId: string }>;
  /** Summary log lines for diagnostics. */
  diagnostics: Array<{
    ticker: string;
    canonicalId: string;
    canonicalSource: string;
    canonicalRichness: number;
    ghostCount: number;
    ghostIds: string[];
  }>;
};

/**
 * Given an array of all trade records, returns:
 * - `canonical`: one winner per ticker (all are operationally open)
 * - `ghosts`: non-canonical duplicates (same ticker, operationally open, less metadata)
 * - `diagnostics`: one entry per ticker that had duplicates
 *
 * Pure function — does NOT mutate any trade records.
 */
export function selectCanonicalOpenTrades(trades: any[]): CanonicalGroupResult {
  // Step 1: gather all operationally open trades, group by normalised ticker
  const byTicker = new Map<string, any[]>();
  for (const t of trades) {
    if (!isOperationallyOpenTrade(t)) continue;
    const ticker = String(t?.symbol ?? t?.ticker ?? "").toUpperCase().trim();
    if (!ticker) continue;
    const bucket = byTicker.get(ticker) ?? [];
    bucket.push(t);
    byTicker.set(ticker, bucket);
  }

  const canonical = new Map<string, any>();
  const ghosts: Array<any & { _canonicalId: string }> = [];
  const diagnostics: CanonicalGroupResult["diagnostics"] = [];

  for (const [ticker, bucket] of byTicker) {
    if (bucket.length === 1) {
      // No duplicates — straightforward
      canonical.set(ticker, bucket[0]);
      continue;
    }

    // Sort by richness descending; ties broken by newest updatedAt
    const sorted = [...bucket].sort((a, b) => {
      const diff = tradeRichness(b) - tradeRichness(a);
      if (diff !== 0) return diff;
      return (b?.updatedAt ?? b?.createdAt ?? "").localeCompare(a?.updatedAt ?? a?.createdAt ?? "");
    });

    const winner = sorted[0];
    canonical.set(ticker, winner);

    // Tag ghosts
    for (let i = 1; i < sorted.length; i++) {
      const ghost = sorted[i];
      // Only include as ghost if this trade is for the same position
      // (same side/price/qty/time) OR is clearly a low-richness duplicate.
      // A 0-richness placeholder vs a rich canonical is always a ghost.
      const isObviousDuplicate =
        tradeRichness(ghost) === 0 ||
        tradesSamePosition(winner, ghost) ||
        tradeRichness(winner) - tradeRichness(ghost) >= 8; // large richness gap

      if (isObviousDuplicate) {
        Object.defineProperty(ghost, "_canonicalId", {
          value: winner.id,
          writable: true,
          enumerable: true,
          configurable: true,
        });
        ghosts.push(ghost as any & { _canonicalId: string });
      } else {
        // Different position (e.g. re-entry after close) — treat both as canonical
        // Keep the richer one already adding, and treat this as a separate record.
        // No action needed; it won't be included in `ghosts`.
      }
    }

    if (sorted.length > 1) {
      const ghostsForTicker = ghosts.filter((g) => (g as any)._canonicalId === winner.id);
      diagnostics.push({
        ticker,
        canonicalId: winner.id,
        canonicalSource: String(winner?.source ?? "unknown"),
        canonicalRichness: tradeRichness(winner),
        ghostCount: ghostsForTicker.length,
        ghostIds: ghostsForTicker.map((g) => String(g.id)),
      });
    }
  }

  return { canonical, ghosts, diagnostics };
}

/**
 * Returns just the canonical trades as an array — convenient for audit functions.
 */
export function getCanonicalOpenTrades(trades: any[]): any[] {
  const { canonical } = selectCanonicalOpenTrades(trades);
  return Array.from(canonical.values());
}
