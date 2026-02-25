export type SessionTag = "PRE" | "RTH" | "POST" | "CLOSED";

type AnyTrade = Record<string, any>;

export type EligibilityConfig = {
  todayET: string;
  currentSessionTag: SessionTag;
  marketIsOpen: boolean;
  maxAgeMin: number;
  rescoreAfterMin: number;
  blockCarryover: boolean;
};

export type EligibilityResult = {
  eligible: boolean;
  reason:
    | "eligible"
    | "stale_trade"
    | "carryover_session"
    | "invalid_trade"
    | "not_scored"
    | "rescore_required"
    | "rescore_failed";
  ageMin: number;
  etDate: string;
  sessionTag: SessionTag;
  requiresRescore: boolean;
};

function safeNum(v: any, fb = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

function etParts(dateInput: string | Date) {
  const date = typeof dateInput === "string" ? new Date(dateInput) : dateInput;
  const fmtDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const fmtHour = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const etDate = fmtDate.format(date);
  const hm = fmtHour.format(date).split(":");
  const hour = Number(hm[0] || 0);
  const minute = Number(hm[1] || 0);
  return { etDate, hour, minute };
}

export function sessionTagFromEtTime(hour: number, minute: number): SessionTag {
  const mins = hour * 60 + minute;
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return "PRE";
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return "RTH";
  if (mins >= 16 * 60 && mins < 20 * 60) return "POST";
  return "CLOSED";
}

export function deriveSessionMeta(nowIso: string) {
  const { etDate, hour, minute } = etParts(nowIso);
  return {
    etDate,
    sessionTag: sessionTagFromEtTime(hour, minute),
  };
}

export function getTradeTimestamp(trade: AnyTrade): string {
  return String(trade?.createdAt || trade?.updatedAt || trade?.openedAt || "");
}

export function getTradeEtDate(trade: AnyTrade): string {
  const iso = getTradeTimestamp(trade);
  if (!iso) return "";
  return etParts(iso).etDate;
}

export function getTradeSessionTag(trade: AnyTrade): SessionTag {
  const iso = getTradeTimestamp(trade);
  if (!iso) return "CLOSED";
  const { hour, minute } = etParts(iso);
  return sessionTagFromEtTime(hour, minute);
}

export function getTradeAgeMin(trade: AnyTrade, nowIso: string) {
  const baseTs = Date.parse(getTradeTimestamp(trade));
  const nowTs = Date.parse(nowIso);
  if (!Number.isFinite(baseTs) || !Number.isFinite(nowTs)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (nowTs - baseTs) / 60000);
}

export function hasValidTradeRisk(trade: AnyTrade) {
  const ticker = String(trade?.ticker || "").toUpperCase();
  const side = String(trade?.side || "").toUpperCase();
  const entry = safeNum(trade?.entryPrice, 0);
  const stop = safeNum(trade?.stopPrice, 0);
  const tp = safeNum(trade?.takeProfitPrice ?? trade?.targetPrice, 0);
  if (!ticker || !["LONG", "SHORT"].includes(side)) return false;
  if (!(entry > 0 && stop > 0 && tp > 0)) return false;
  if (side === "LONG" && (stop >= entry || tp <= entry)) return false;
  if (side === "SHORT" && (stop <= entry || tp >= entry)) return false;
  return true;
}

export function isScoredTrade(trade: AnyTrade) {
  const s = safeNum(trade?.aiScore ?? trade?.score ?? trade?.ai?.score, Number.NaN);
  const qualified = trade?.qualified === true;
  const grade = String((trade?.aiGrade ?? trade?.grade ?? trade?.ai?.grade) || "");
  return Number.isFinite(s) || qualified || Boolean(grade);
}

function canonicalSortTs(trade: AnyTrade) {
  const ts = Date.parse(getTradeTimestamp(trade));
  return Number.isFinite(ts) ? ts : 0;
}

export function pickCanonicalPendingByTicker<T extends AnyTrade>(trades: T[]) {
  const byTicker = new Map<string, T[]>();
  for (const t of trades) {
    const ticker = String(t?.ticker || "").toUpperCase();
    if (!ticker) continue;
    const arr = byTicker.get(ticker) || [];
    arr.push(t);
    byTicker.set(ticker, arr);
  }

  const canonical: T[] = [];
  const duplicates: T[] = [];
  for (const [, list] of byTicker.entries()) {
    const sorted = [...list].sort((a, b) => canonicalSortTs(b) - canonicalSortTs(a));
    if (sorted[0]) canonical.push(sorted[0]);
    if (sorted.length > 1) duplicates.push(...sorted.slice(1));
  }
  return { canonical, duplicates };
}

export function evaluatePendingEligibility(
  trade: AnyTrade,
  nowIso: string,
  cfg: EligibilityConfig
): EligibilityResult {
  const etDate = getTradeEtDate(trade);
  const sessionTag = getTradeSessionTag(trade);
  const ageMin = getTradeAgeMin(trade, nowIso);

  if (!Number.isFinite(ageMin)) {
    return {
      eligible: false,
      reason: "stale_trade",
      ageMin,
      etDate,
      sessionTag,
      requiresRescore: false,
    };
  }

  if (
    cfg.blockCarryover &&
    (!etDate || etDate !== cfg.todayET || (!cfg.marketIsOpen && sessionTag !== cfg.currentSessionTag))
  ) {
    return {
      eligible: false,
      reason: "carryover_session",
      ageMin,
      etDate,
      sessionTag,
      requiresRescore: false,
    };
  }

  if (!hasValidTradeRisk(trade)) {
    return {
      eligible: false,
      reason: "invalid_trade",
      ageMin,
      etDate,
      sessionTag,
      requiresRescore: false,
    };
  }

  if (!isScoredTrade(trade)) {
    return {
      eligible: false,
      reason: "not_scored",
      ageMin,
      etDate,
      sessionTag,
      requiresRescore: false,
    };
  }

  if (ageMin > cfg.maxAgeMin) {
    return {
      eligible: false,
      reason: "stale_trade",
      ageMin,
      etDate,
      sessionTag,
      requiresRescore: false,
    };
  }

  if (cfg.rescoreAfterMin > 0 && ageMin > cfg.rescoreAfterMin) {
    return {
      eligible: false,
      reason: "rescore_required",
      ageMin,
      etDate,
      sessionTag,
      requiresRescore: true,
    };
  }

  return {
    eligible: true,
    reason: "eligible",
    ageMin,
    etDate,
    sessionTag,
    requiresRescore: false,
  };
}

export function pickCanonicalEligibleByTicker<T extends AnyTrade>(
  trades: T[],
  nowIso: string,
  cfg: EligibilityConfig
) {
  const byTicker = new Map<string, T[]>();
  for (const t of trades) {
    const ticker = String(t?.ticker || "").toUpperCase();
    if (!ticker) continue;
    const arr = byTicker.get(ticker) || [];
    arr.push(t);
    byTicker.set(ticker, arr);
  }

  const canonical = new Map<string, T>();

  for (const [ticker, list] of byTicker.entries()) {
    const sorted = [...list].sort((a, b) => canonicalSortTs(b) - canonicalSortTs(a));
    const chosen = sorted.find((t) => evaluatePendingEligibility(t, nowIso, cfg).reason === "eligible");
    if (chosen) canonical.set(ticker, chosen);
  }

  return canonical;
}
