type SignalLike = {
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  scoredAt?: string;
};

export type CreatedWindowStats = {
  total: number;
  pending: number;
  scored: number;
  error: number;
};

export type ScoredWindowStats = {
  total: number;
  scored: number;
  error: number;
  lastScoredAt: string | null;
};

function normalizeStatus(status?: string) {
  return String(status || "").trim().toUpperCase();
}

function parseTimestampMs(value?: string | null): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function getEffectiveScoredAt(signal: SignalLike): string | null {
  if (signal.scoredAt) return signal.scoredAt;
  const status = normalizeStatus(signal.status);
  if (status === "SCORED" || status === "ERROR") {
    return signal.updatedAt ?? null;
  }
  return null;
}

export function computeScoringWindows(signals: SignalLike[], now = new Date()) {
  const nowMs = now.getTime();
  const sixHoursAgoMs = nowMs - 6 * 60 * 60 * 1000;

  const createdLast6Hours = signals.filter((s) => {
    const t = parseTimestampMs(s.createdAt);
    return t != null && t >= sixHoursAgoMs && t <= nowMs;
  });

  const createdStats: CreatedWindowStats = {
    total: createdLast6Hours.length,
    pending: createdLast6Hours.filter((s) => normalizeStatus(s.status) === "PENDING").length,
    scored: createdLast6Hours.filter((s) => normalizeStatus(s.status) === "SCORED").length,
    error: createdLast6Hours.filter((s) => normalizeStatus(s.status) === "ERROR").length,
  };

  const scoredLast6Hours = signals.filter((s) => {
    const effective = getEffectiveScoredAt(s);
    const t = parseTimestampMs(effective);
    return t != null && t >= sixHoursAgoMs && t <= nowMs;
  });

  const lastScoredAt = scoredLast6Hours
    .map((s) => getEffectiveScoredAt(s))
    .filter(Boolean)
    .sort()
    .slice(-1)[0] ?? null;

  const scoredStats: ScoredWindowStats = {
    total: scoredLast6Hours.length,
    scored: scoredLast6Hours.filter((s) => normalizeStatus(s.status) === "SCORED").length,
    error: scoredLast6Hours.filter((s) => normalizeStatus(s.status) === "ERROR").length,
    lastScoredAt,
  };

  return { createdLast6Hours: createdStats, scoredLast6Hours: scoredStats };
}
