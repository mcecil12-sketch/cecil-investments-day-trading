type CanonicalCandidate = {
  source?: string | null;
  entryPrice?: number | null;
  stopPrice?: number | null;
  openedAt?: string | null;
};

function isAutoSource(source: any) {
  return String(source || "").toUpperCase() === "AUTO";
}

function hasValidEntryAndStop(trade: CanonicalCandidate) {
  const entry = Number(trade?.entryPrice);
  const stop = trade?.stopPrice;
  return Number.isFinite(entry) && entry > 0 && stop != null;
}

function openedAtEpoch(trade: CanonicalCandidate) {
  const ts = Date.parse(String(trade?.openedAt || ""));
  return Number.isFinite(ts) ? ts : Number.NEGATIVE_INFINITY;
}

export function selectCanonicalOpenTrade<T extends CanonicalCandidate>(trades: T[]): {
  canonical: T;
  duplicates: T[];
} {
  if (!Array.isArray(trades) || trades.length === 0) {
    throw new Error("selectCanonicalOpenTrade requires at least one trade");
  }

  const ranked = trades
    .map((trade, index) => ({ trade, index }))
    .sort((a, b) => {
      const aAuto = isAutoSource(a.trade?.source) ? 1 : 0;
      const bAuto = isAutoSource(b.trade?.source) ? 1 : 0;
      if (aAuto !== bAuto) return bAuto - aAuto;

      const aValid = hasValidEntryAndStop(a.trade) ? 1 : 0;
      const bValid = hasValidEntryAndStop(b.trade) ? 1 : 0;
      if (aValid !== bValid) return bValid - aValid;

      const aOpened = openedAtEpoch(a.trade);
      const bOpened = openedAtEpoch(b.trade);
      if (aOpened !== bOpened) return bOpened - aOpened;

      return a.index - b.index;
    });

  const canonical = ranked[0].trade;
  const duplicates = ranked.slice(1).map((x) => x.trade);
  return { canonical, duplicates };
}
