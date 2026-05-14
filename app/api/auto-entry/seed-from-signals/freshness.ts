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
  freshnessBucket: "under10min" | "under20min" | "under45min" | "over45min" | "over90min" | "over180min";
  isSeedEligible: boolean;
  isHardDrop: boolean;
  freshnessReason: "fresh_within_threshold" | "stale_over_threshold" | "missing_timestamp";
};

export type FreshnessEvaluationOptions = {
  maxSeedAgeMs?: number;
  hardDropAgeMs?: number;
  recoveryMode?: boolean;
};

function resolveFreshnessBucket(ageMs: number): FreshnessDecision["freshnessBucket"] {
  if (ageMs < 10 * 60_000) return "under10min";
  if (ageMs < 20 * 60_000) return "under20min";
  if (ageMs < 45 * 60_000) return "under45min";
  if (ageMs < 90 * 60_000) return "over45min";
  if (ageMs < 180 * 60_000) return "over90min";
  return "over180min";
}

export function evaluateSignalFreshnessDecision(
  signal: RawSignal,
  nowMs: number,
  effectiveFreshnessMs: number,
  options: FreshnessEvaluationOptions = {}
): FreshnessDecision {
  const signalId = String(signal?.id || "").trim();
  const symbol = getSymbol(signal) || "UNKNOWN";
  const createdAt = String(signal?.createdAt || signal?.updatedAt || new Date(nowMs).toISOString());
  const tsMs = getSignalTimestampMs(signal);
  const ageMs = Number.isFinite(tsMs) ? Math.max(0, nowMs - (tsMs as number)) : Number.POSITIVE_INFINITY;
  const maxSeedAgeMs = Number.isFinite(options.maxSeedAgeMs)
    ? Math.max(1, Number(options.maxSeedAgeMs))
    : 90 * 60_000;
  const hardDropAgeMs = Number.isFinite(options.hardDropAgeMs)
    ? Math.max(maxSeedAgeMs, Number(options.hardDropAgeMs))
    : 180 * 60_000;
  const recoveryMode = options.recoveryMode === true;

  if (!Number.isFinite(ageMs)) {
    return {
      signalId,
      symbol,
      createdAt,
      ageMs,
      isFresh: false,
      freshnessBucket: "over180min",
      isSeedEligible: false,
      isHardDrop: true,
      freshnessReason: "missing_timestamp",
    };
  }

  const isFresh = ageMs <= effectiveFreshnessMs;
  const freshnessBucket = resolveFreshnessBucket(ageMs);
  const isHardDrop = ageMs > hardDropAgeMs;
  const inRecoveryWindow = ageMs > effectiveFreshnessMs && ageMs <= maxSeedAgeMs;
  const isSeedEligible = !isHardDrop && (isFresh || (recoveryMode && inRecoveryWindow));

  return {
    signalId,
    symbol,
    createdAt,
    ageMs,
    isFresh,
    freshnessBucket,
    isSeedEligible,
    isHardDrop,
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
    case "eod_45m":
      return "eod_window_policy_45m";
    case "market_default_60m":
      return "market_open_default_60m";
    case "market_default_45m":
      return "market_open_default_45m";
    case "closed_default_10m":
      return "market_closed_default_10m";
    default:
      return "unknown";
  }
}
