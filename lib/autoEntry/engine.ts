import { getAutoConfig } from "./config";
import { readTrades } from "@/lib/tradesStore";
import { fetchAlpacaClock } from "@/lib/alpacaClock";
import { alpacaRequest } from "@/lib/alpaca";
import {
  deriveSessionMeta,
  evaluatePendingEligibility,
  getTradeTimestamp,
  type EligibilityConfig,
} from "@/lib/autoEntry/eligibility";
import { scoreSignalWithAI } from "@/lib/aiScoring";

type AnyTrade = Record<string, any>;

type EnsureTokenSuccess = {
  ok: true;
  cfg: ReturnType<typeof getAutoConfig>;
};

type EnsureTokenFailure =
  | { ok: false; status: 500; error: "AUTO_ENTRY_TOKEN missing" }
  | { ok: false; status: 401; error: "unauthorized" };

type EnsureTokenResult = EnsureTokenSuccess | EnsureTokenFailure;

type RunAction = {
  id: string;
  ticker: string;
  side: string;
  decision: "WOULD_EXECUTE" | "SKIP";
  reason: string;
};

function nowIso() {
  return new Date().toISOString();
}

function safeNum(v: any, fb = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}

function headerToken(req: Request) {
  const h = req.headers.get("x-auto-entry-token") || "";
  if (h) return h;
  const auth = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  return auth.replace(/^Bearer\s+/i, "").trim();
}

function ensureToken(req: Request): EnsureTokenResult {
  const cfg = getAutoConfig();
  if (!cfg.token) return { ok: false, status: 500, error: "AUTO_ENTRY_TOKEN missing" as const };
  const got = headerToken(req);
  if (!got || got !== cfg.token) return { ok: false, status: 401, error: "unauthorized" as const };
  return { ok: true as const, cfg };
}

function isAutoPendingTrade(t: AnyTrade) {
  return (
    String(t?.status || "").toUpperCase() === "AUTO_PENDING" &&
    ["AUTO", "AUTO-ENTRY"].includes(String(t?.source || "").toUpperCase())
  );
}

function getTakeProfit(trade: AnyTrade) {
  return safeNum(trade?.takeProfitPrice ?? trade?.targetPrice, 0);
}

function hasMissingFields(trade: AnyTrade) {
  const ticker = String(trade?.ticker || "").toUpperCase();
  const side = String(trade?.side || "").toUpperCase();
  const entry = safeNum(trade?.entryPrice, 0);
  const stop = safeNum(trade?.stopPrice, 0);
  const tp = getTakeProfit(trade);

  return !ticker || !["LONG", "SHORT"].includes(side) || !(entry > 0) || !(stop > 0) || !(tp > 0);
}

function hasInvalidPrices(trade: AnyTrade) {
  const side = String(trade?.side || "").toUpperCase();
  const entry = safeNum(trade?.entryPrice, 0);
  const stop = safeNum(trade?.stopPrice, 0);
  const tp = getTakeProfit(trade);

  if (side === "LONG") {
    return stop >= entry || tp <= entry;
  }
  if (side === "SHORT") {
    return stop <= entry || tp >= entry;
  }
  return true;
}

function byNewestCreatedAtDesc(a: AnyTrade, b: AnyTrade) {
  const aTs = Date.parse(getTradeTimestamp(a)) || 0;
  const bTs = Date.parse(getTradeTimestamp(b)) || 0;
  return bTs - aTs;
}

async function hasOpenOrderForTicker(ticker: string): Promise<boolean> {
  const qs = `status=open&symbols=${encodeURIComponent(ticker)}&limit=50`;
  const resp = await alpacaRequest({ method: "GET", path: `/v2/orders?${qs}` });
  if (!resp.ok) return false;
  try {
    const parsed = JSON.parse(resp.text || "[]");
    const arr = Array.isArray(parsed) ? parsed : [];
    return arr.length > 0;
  } catch {
    return false;
  }
}

function inc(map: Record<string, number>, reason: string) {
  map[reason] = (map[reason] ?? 0) + 1;
}

function toRawSignal(trade: AnyTrade) {
  const sideRaw = String(trade?.side || "").toUpperCase();
  const side: "LONG" | "SHORT" = sideRaw === "SHORT" ? "SHORT" : "LONG";
  return {
    id: trade?.signalId || trade?.id,
    ticker: String(trade?.ticker || "").toUpperCase(),
    timeframe: "1Min",
    createdAt: String(getTradeTimestamp(trade) || new Date().toISOString()),
    entryPrice: safeNum(trade?.entryPrice, 0),
    stopPrice: safeNum(trade?.stopPrice, 0),
    targetPrice: safeNum(trade?.takeProfitPrice ?? trade?.targetPrice, 0),
    side,
    source: trade?.source || "AUTO",
    status: "SCORED",
  };
}

async function tryRescoreTrade(trade: AnyTrade) {
  const result = await scoreSignalWithAI(toRawSignal(trade));
  const scored = (result as any)?.scored || {};
  const score = Number(scored?.aiScore ?? scored?.score);
  const grade = String(scored?.aiGrade || scored?.grade || "");
  const qualified = scored?.qualified === true || Number.isFinite(score) || Boolean(grade);
  const bestDirection = String(scored?.bestDirection || scored?.direction || scored?.side || trade?.side || "").toUpperCase();
  const summary = String(scored?.aiSummary || scored?.summary || "");

  if (!qualified) {
    return { ok: false as const };
  }

  const now = new Date().toISOString();

  return {
    ok: true as const,
    patch: {
      aiScore: Number.isFinite(score) ? score : trade?.aiScore ?? null,
      aiGrade: grade || trade?.aiGrade || null,
      qualified: scored?.qualified === true,
      bestDirection,
      aiSummary: summary || trade?.aiSummary || "",
      rescoredAt: now,
      updatedAt: now,
      ai: {
        ...(trade?.ai || {}),
        score: Number.isFinite(score) ? score : trade?.ai?.score ?? null,
        grade: grade || trade?.ai?.grade || null,
        qualified: scored?.qualified === true,
        bestDirection,
        summary: summary || trade?.ai?.summary || "",
      },
    },
  };
}

export async function runAutoEntryOnce(req: Request) {
  const auth = ensureToken(req);
  if (!auth.ok) return auth;

  const cfg = auth.cfg;
  const startedAt = nowIso();
  const url = new URL(req.url);
  const dryRun = ["1", "true", "yes", "on"].includes(
    String(url.searchParams.get("dryRun") || "").toLowerCase()
  );

  if (!cfg.enabled) {
    return { ok: true, skipped: true, reason: "AUTO_TRADING_ENABLED=false", startedAt, dryRun };
  }
  if (!cfg.paperOnly) {
    return {
      ok: true,
      skipped: true,
      reason: "AUTO_TRADING_PAPER_ONLY=false (blocked in Phase 4)",
      startedAt,
      dryRun,
    };
  }

  let marketIsOpen = false;
  let marketTimestamp = startedAt;
  try {
    const clock = await fetchAlpacaClock();
    marketIsOpen = Boolean(clock.is_open);
    marketTimestamp = String((clock as any)?.timestamp || (clock as any)?.next_open || startedAt);
  } catch {
    marketIsOpen = false;
  }

  const maxAgeMin = Number.isFinite(Number(process.env.AUTO_ENTRY_MAX_AGE_MIN))
    ? Math.max(1, Number(process.env.AUTO_ENTRY_MAX_AGE_MIN))
    : 15;
  const rescoreAfterMin = Number.isFinite(Number(process.env.AUTO_ENTRY_RESCORE_AFTER_MIN))
    ? Math.max(0, Number(process.env.AUTO_ENTRY_RESCORE_AFTER_MIN))
    : 10;
  const blockCarryover = ["1", "true", "yes", "on"].includes(
    String(process.env.AUTO_ENTRY_BLOCK_CARRYOVER || "1").toLowerCase()
  );

  const sessionMeta = deriveSessionMeta(marketTimestamp || startedAt);
  const eligibilityCfg: EligibilityConfig = {
    todayET: sessionMeta.etDate,
    currentSessionTag: sessionMeta.sessionTag,
    marketIsOpen: marketIsOpen,
    maxAgeMin,
    rescoreAfterMin,
    blockCarryover,
  };

  const allTrades = await readTrades<AnyTrade>();
  const pending = allTrades.filter(isAutoPendingTrade);

  const pendingSorted = [...pending].sort(byNewestCreatedAtDesc);
  const pendingSample = pendingSorted.slice(0, 10).map((t) => ({
    id: String(t?.id || ""),
    ticker: String(t?.ticker || "").toUpperCase(),
    side: String(t?.side || "").toUpperCase(),
    etDate: t?.etDate ?? null,
    sessionTag: t?.sessionTag ?? null,
    timestamp: getTradeTimestamp(t) || null,
    entryPrice: t?.entryPrice ?? null,
    stopPrice: t?.stopPrice ?? null,
    takeProfitPrice: t?.takeProfitPrice ?? t?.targetPrice ?? null,
    createdAt: t?.createdAt ?? null,
  }));

  const byTicker = new Map<string, AnyTrade[]>();
  for (const t of pendingSorted) {
    const ticker = String(t?.ticker || "").toUpperCase();
    if (!ticker) continue;
    const arr = byTicker.get(ticker) || [];
    arr.push(t);
    byTicker.set(ticker, arr);
  }

  const canonicalByTicker: AnyTrade[] = [];
  const skipsByReason: Record<string, number> = {};
  const actions: RunAction[] = [];

  const openTrades = allTrades.filter(
    (t) => String(t?.status || "").toUpperCase() === "OPEN"
  );
  const openTickers = new Set(openTrades.map((t) => String(t?.ticker || "").toUpperCase()).filter(Boolean));
  const openPositionsCount = openTickers.size;

  const today = sessionMeta.etDate;
  const entriesToday = allTrades.filter((t) => {
    const createdAt = String(t?.createdAt || "");
    const src = String(t?.source || "").toUpperCase();
    return createdAt.startsWith(today) && (src === "AUTO" || src === "AUTO-ENTRY");
  }).length;

  let eligibleCount = 0;

  const globalMaxOpenBlocked = openPositionsCount >= cfg.maxOpen;
  if (globalMaxOpenBlocked) inc(skipsByReason, "max_open_positions");

  const globalMaxPerDayBlocked = entriesToday >= cfg.maxPerDay;
  if (globalMaxPerDayBlocked) inc(skipsByReason, "max_entries_per_day");

  if (!marketIsOpen) inc(skipsByReason, "market_closed");

  for (const [ticker, group] of byTicker.entries()) {
    const sorted = [...group].sort(byNewestCreatedAtDesc);
    let selected: AnyTrade | null = null;
    const processedIds = new Set<string>();

    for (const trade of sorted) {
      const id = String(trade?.id || "");
      const side = String(trade?.side || "").toUpperCase();
      let workingTrade = trade;
      let eligibility = evaluatePendingEligibility(workingTrade, startedAt, eligibilityCfg);

      if (!eligibility.eligible && eligibility.requiresRescore) {
        try {
          const rescored = await tryRescoreTrade(workingTrade);
          if (!rescored.ok) {
            actions.push({ id, ticker, side, decision: "SKIP", reason: "rescore_failed" });
            inc(skipsByReason, "rescore_failed");
            processedIds.add(id);
            continue;
          }
          workingTrade = { ...workingTrade, ...rescored.patch };
          eligibility = evaluatePendingEligibility(workingTrade, startedAt, eligibilityCfg);
        } catch {
          actions.push({ id, ticker, side, decision: "SKIP", reason: "rescore_failed" });
          inc(skipsByReason, "rescore_failed");
          processedIds.add(id);
          continue;
        }
      }

      if (!eligibility.eligible) {
        actions.push({ id, ticker, side, decision: "SKIP", reason: eligibility.reason });
        inc(skipsByReason, eligibility.reason);
        processedIds.add(id);
        continue;
      }

      if (hasMissingFields(workingTrade)) {
        actions.push({ id, ticker, side, decision: "SKIP", reason: "missing_fields" });
        inc(skipsByReason, "missing_fields");
        processedIds.add(id);
        continue;
      }

      if (hasInvalidPrices(workingTrade)) {
        actions.push({ id, ticker, side, decision: "SKIP", reason: "invalid_prices" });
        inc(skipsByReason, "invalid_prices");
        processedIds.add(id);
        continue;
      }

      selected = workingTrade;
      canonicalByTicker.push(workingTrade);
      processedIds.add(id);
      break;
    }

    if (selected) {
      for (const trade of sorted) {
        const id = String(trade?.id || "");
        if (processedIds.has(id)) continue;
        actions.push({
          id,
          ticker,
          side: String(trade?.side || "").toUpperCase(),
          decision: "SKIP",
          reason: "duplicate_ticker",
        });
        inc(skipsByReason, "duplicate_ticker");
      }
    }
  }

  for (const trade of canonicalByTicker) {
    const id = String(trade?.id || "");
    const ticker = String(trade?.ticker || "").toUpperCase();
    const side = String(trade?.side || "").toUpperCase();

    if (hasMissingFields(trade)) {
      actions.push({ id, ticker, side, decision: "SKIP", reason: "missing_fields" });
      inc(skipsByReason, "missing_fields");
      continue;
    }

    if (hasInvalidPrices(trade)) {
      actions.push({ id, ticker, side, decision: "SKIP", reason: "invalid_prices" });
      inc(skipsByReason, "invalid_prices");
      continue;
    }

    if (openTickers.has(ticker)) {
      actions.push({ id, ticker, side, decision: "SKIP", reason: "already_open" });
      inc(skipsByReason, "already_open");
      continue;
    }

    if (globalMaxOpenBlocked) {
      actions.push({ id, ticker, side, decision: "SKIP", reason: "max_open_positions" });
      continue;
    }

    if (globalMaxPerDayBlocked) {
      actions.push({ id, ticker, side, decision: "SKIP", reason: "max_entries_per_day" });
      continue;
    }

    const hasOpenOrder = await hasOpenOrderForTicker(ticker);
    if (hasOpenOrder) {
      actions.push({ id, ticker, side, decision: "SKIP", reason: "already_has_open_order" });
      inc(skipsByReason, "already_has_open_order");
      continue;
    }

    eligibleCount += 1;

    if (!marketIsOpen) {
      actions.push({ id, ticker, side, decision: "WOULD_EXECUTE", reason: "market_closed" });
      continue;
    }

    if (dryRun) {
      actions.push({ id, ticker, side, decision: "WOULD_EXECUTE", reason: "dry_run" });
    } else {
      actions.push({ id, ticker, side, decision: "WOULD_EXECUTE", reason: "execution_delegated_to_execute_endpoint" });
    }
  }

  return {
    ok: true,
    startedAt,
    dryRun,
    market: {
      isOpen: marketIsOpen,
      timestamp: marketTimestamp,
      reason: marketIsOpen ? undefined : "market_closed",
    },
    policy: {
      todayET: sessionMeta.etDate,
      sessionTag: sessionMeta.sessionTag,
      maxAgeMin,
      rescoreAfterMin,
      blockCarryover,
    },
    pendingCount: pending.length,
    eligibleCount,
    openPositionsCount,
    maxOpenPositions: cfg.maxOpen,
    entriesToday,
    maxEntriesPerDay: cfg.maxPerDay,
    skipsByReason,
    pendingSample,
    actions,
  };
}
