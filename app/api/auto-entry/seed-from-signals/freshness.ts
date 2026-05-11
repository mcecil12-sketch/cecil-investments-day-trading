type RawSignal = Record<string, any>;

function parseTimestampMs(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw < 1e11 ? raw * 1000 : raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const asNum = Number(trimmed);
    if (Number.isFinite(asNum)) {
      return asNum < 1e11 ? asNum * 1000 : asNum;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function getSignalTimestampMs(signal: RawSignal): number | null {
  return (
    parseTimestampMs(signal?.createdAt) ??
    parseTimestampMs(signal?.scoredAt) ??
    parseTimestampMs(signal?.updatedAt)
  );
}

function getSymbol(signal: RawSignal): string {
  const raw = signal?.symbol ?? signal?.ticker;
  return String(raw || "").trim().toUpperCase();
}

export type FreshnessDecision = {
  signalId: string;
  symbol: string;
  createdAt: string;
  ageMs: number;
  isFresh: boolean;
  freshnessReason: "fresh_within_threshold" | "stale_over_threshold" | "missing_timestamp";
};

export function evaluateSignalFreshnessDecision(
  signal: RawSignal,
  nowMs: number,
  effectiveFreshnessMs: number
): FreshnessDecision {
  const signalId = String(signal?.id || "").trim();
  const symbol = getSymbol(signal) || "UNKNOWN";
  const createdAt = String(signal?.createdAt || signal?.updatedAt || new Date(nowMs).toISOString());
  const tsMs = getSignalTimestampMs(signal);
  const ageMs = Number.isFinite(tsMs) ? Math.max(0, nowMs - (tsMs as number)) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(ageMs)) {
    return {
      signalId,
      symbol,
      createdAt,
      ageMs,
      isFresh: false,
      freshnessReason: "missing_timestamp",
    };
  }

  const isFresh = ageMs <= effectiveFreshnessMs;
  return {
    signalId,
    symbol,
    createdAt,
    ageMs,
    isFresh,
    freshnessReason: isFresh ? "fresh_within_threshold" : "stale_over_threshold",
  };
}

export function getFreshnessThresholdSource(freshnessMode: string): string {
  switch (freshnessMode) {
    case "param_override":
      return "query_param_freshMs";
    case "env_override":
      return "AUTO_ENTRY_SIGNAL_FRESH_MS";
    case "legacy_env_min":
      return "AUTO_ENTRY_SEED_MAX_AGE_MIN";
    case "eod_75m":
      return "eod_window_policy_75m";
    case "market_default_60m":
      return "market_open_default_60m";
    case "closed_default_10m":
      return "market_closed_default_10m";
    default:
      return "unknown";
  }
}
