const up = (v: any) => String(v || "").toUpperCase();

export function tradeTicker(trade: any): string {
  return up(trade?.ticker);
}

export function isAutoPendingTrade(trade: any): boolean {
  const status = up(trade?.status);
  const autoEntryStatus = up(trade?.autoEntryStatus);
  return status === "AUTO_PENDING" || autoEntryStatus === "AUTO_PENDING";
}

export function hasLivePositionMarker(trade: any): boolean {
  const alpacaStatus = String(trade?.alpacaStatus || "").toLowerCase();
  const brokerStatus = String(trade?.brokerStatus || "").toLowerCase();
  return alpacaStatus === "position_open" || brokerStatus === "position_open";
}

export function isOperationallyOpenTrade(trade: any): boolean {
  const status = up(trade?.status);
  // Never count ARCHIVED or CLOSED as operational, even if they have position markers
  if (status === "ARCHIVED" || status === "CLOSED") return false;
  return status === "OPEN" || hasLivePositionMarker(trade);
}

export function isOperationallyActiveTrade(trade: any): boolean {
  return isOperationallyOpenTrade(trade) || isAutoPendingTrade(trade);
}

export function getOperationallyActiveTickers(trades: any[]): Set<string> {
  const out = new Set<string>();
  for (const trade of Array.isArray(trades) ? trades : []) {
    if (!isOperationallyActiveTrade(trade)) continue;
    const ticker = tradeTicker(trade);
    if (ticker) out.add(ticker);
  }
  return out;
}

export function isLegacyErrorNoiseTrade(trade: any, activeTickers: Set<string>): boolean {
  const ticker = tradeTicker(trade);
  if (!ticker) return false;
  if (up(trade?.status) !== "ERROR") return false;
  if (isOperationallyActiveTrade(trade)) return false;
  return activeTickers.has(ticker);
}

export function countOperationalOpenTickers(trades: any[]): number {
  const openTickers = new Set<string>();
  for (const trade of Array.isArray(trades) ? trades : []) {
    if (!isOperationallyOpenTrade(trade)) continue;
    const ticker = tradeTicker(trade);
    if (ticker) openTickers.add(ticker);
  }
  return openTickers.size;
}

export function countOperationalOpenAutoTickers(trades: any[]): number {
  const out = new Set<string>();
  for (const trade of Array.isArray(trades) ? trades : []) {
    if (!isOperationallyOpenTrade(trade)) continue;
    const source = up(trade?.source);
    if (source !== "AUTO" && source !== "AUTO-ENTRY") continue;
    const ticker = tradeTicker(trade);
    if (ticker) out.add(ticker);
  }
  return out.size;
}

export function normalizedOperationalStatus(trade: any): string {
  if (isOperationallyOpenTrade(trade)) return "OPEN";
  if (isAutoPendingTrade(trade)) return "AUTO_PENDING";
  return up(trade?.status) || "UNKNOWN";
}
