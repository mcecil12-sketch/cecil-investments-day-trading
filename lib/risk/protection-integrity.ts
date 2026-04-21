/**
 * Shared protection integrity audit.
 * Pure function — no side effects, no DB writes, no network calls.
 * Callers (protection-audit, readiness, manage) supply broker data.
 */

import {
  normalizeTicker,
  normalizeTradeSide,
  findProtectiveStopOrder,
  type ProtectionStatus,
} from "@/lib/trades/protection";

// ─── Types ──────────────────────────────────────────────────────────

export type BrokerPosition = {
  symbol: string;
  qty: string | number;
  avg_entry_price?: string | number;
  current_price?: string | number;
  market_value?: string | number;
  side?: string;
  [key: string]: any;
};

export type BrokerOrder = {
  id: string;
  symbol: string;
  side: string;
  status: string;
  type?: string;
  stop_price?: string | number;
  time_in_force?: string;
  qty?: string | number;
  [key: string]: any;
};

export type AuditTrade = {
  id: string;
  ticker: string;
  side: string;
  status: string;
  qty?: number;
  stopOrderId?: string;
  protectionStatus?: ProtectionStatus;
  lastProtectionCheckAt?: string;
  [key: string]: any;
};

export type IncidentCode =
  | "MISSING_STOP"
  | "STOP_EXPIRED"
  | "STOP_CANCELED"
  | "STOP_DAY_TIF"
  | "BROKER_DB_MISMATCH"
  | "STOP_REPAIR_FAILED"
  | "FLATTEN_FAILED";

export type Severity = "CRITICAL" | "WARN" | "INFO";

export type ProtectionIncident = {
  code: IncidentCode;
  severity: Severity;
  tradeId: string;
  symbol: string;
  detail: string;
};

export type TradeAuditDetail = {
  tradeId: string;
  symbol: string;
  side: string;
  hasBrokerPosition: boolean;
  brokerQty: number;
  hasActiveStop: boolean;
  activeStopId?: string;
  activeStopTif?: string;
  incidents: ProtectionIncident[];
  /** true when broker has a live position but no matching DB open trade exists */
  isOrphan?: boolean;
};

export type AuditResult = {
  ok: boolean;
  auditedAt: string;
  /** Number of DB open trades audited */
  tradeCount: number;
  protectedCount: number;
  incidentCount: number;
  criticalCount: number;
  incidents: ProtectionIncident[];
  details: TradeAuditDetail[];
  // ── Broker-position coverage fields ──
  /** Total live broker positions with qty > 0 */
  brokerPositionCount: number;
  /** DB open trades that matched a broker position by symbol */
  matchedTradeCount: number;
  /** Broker positions with no matching DB open trade (orphans) */
  unmatchedBrokerPositions: string[];
  /** Combined list of symbols requiring attention (unprotected or orphan) */
  protectionBlockerSymbols: string[];
};

// ─── Helpers ────────────────────────────────────────────────────────

export function envFlag(name: string, fallback: boolean = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

export function parseQty(raw: string | number | undefined | null): number {
  const n = Math.abs(Number(raw ?? 0));
  return Number.isFinite(n) ? n : 0;
}

/**
 * DAY TIF stops expire at market close and leave positions naked overnight.
 * CRITICAL during market hours or when status is unknown (fail-safe).
 * WARN only when market is definitively closed (stop already survived the day).
 */
export function dayTifSeverity(marketOpen?: boolean): Severity {
  if (marketOpen === false) return "WARN";
  return "CRITICAL"; // open, unknown, or after-hours → cautious
}

// ─── Core Audit ─────────────────────────────────────────────────────

export function auditProtectionIntegrity(opts: {
  openTrades: AuditTrade[];
  brokerPositions: BrokerPosition[];
  brokerOrders: BrokerOrder[];
  marketOpen?: boolean;
}): AuditResult {
  const { openTrades, brokerPositions, brokerOrders, marketOpen } = opts;
  const now = new Date().toISOString();

  // Index broker state
  const posBySymbol = new Map<string, BrokerPosition>();
  for (const p of brokerPositions) {
    const sym = normalizeTicker(p.symbol);
    if (sym) posBySymbol.set(sym, p);
  }

  const ordersBySymbol = new Map<string, BrokerOrder[]>();
  for (const o of brokerOrders) {
    const sym = normalizeTicker(o.symbol);
    if (!sym) continue;
    const bucket = ordersBySymbol.get(sym) || [];
    bucket.push(o);
    ordersBySymbol.set(sym, bucket);
  }

  const allIncidents: ProtectionIncident[] = [];
  const details: TradeAuditDetail[] = [];
  let protectedCount = 0;

  // Track which broker-position symbols are covered by a DB open trade
  const openTradeSymbols = new Set<string>();

  for (const trade of openTrades) {
    const sym = normalizeTicker(trade.ticker);
    if (sym) openTradeSymbols.add(sym);
    const symbol = normalizeTicker(trade.ticker);
    const side = normalizeTradeSide(trade.side);
    const brokerPos = posBySymbol.get(symbol);
    const brokerQty = brokerPos ? parseQty(brokerPos.qty) : 0;
    const symbolOrders = ordersBySymbol.get(symbol) || [];

    const tradeIncidents: ProtectionIncident[] = [];

    // 1) Check broker position exists
    if (!brokerPos || brokerQty === 0) {
      tradeIncidents.push({
        code: "BROKER_DB_MISMATCH",
        severity: "CRITICAL",
        tradeId: trade.id,
        symbol,
        detail: `Trade ${trade.id} has no broker position`,
      });
    }

    // 2) Find active protective stop
    let activeStop: BrokerOrder | undefined;
    if (side) {
      const found = findProtectiveStopOrder({
        ticker: symbol,
        tradeSide: side,
        openOrders: symbolOrders,
      });
      if (found) {
        activeStop = symbolOrders.find((o) => o.id === found.id);
      }
    }

    if (!activeStop && brokerQty > 0) {
      const trackedId = trade.stopOrderId;
      tradeIncidents.push({
        code: "MISSING_STOP",
        severity: "CRITICAL",
        tradeId: trade.id,
        symbol,
        detail: trackedId
          ? `No active protective stop; tracked stopOrderId=${trackedId} not in open orders`
          : "No active protective stop and no tracked stop order ID",
      });
    }

    // 3) DAY TIF check
    if (activeStop) {
      const tif = (activeStop.time_in_force || "").toLowerCase();
      if (tif === "day") {
        tradeIncidents.push({
          code: "STOP_DAY_TIF",
          severity: dayTifSeverity(marketOpen),
          tradeId: trade.id,
          symbol,
          detail: `Stop ${activeStop.id} has time_in_force=day; will expire at market close`,
        });
      }
    }

    // 4) Qty mismatch (broker vs stop order)
    if (activeStop && brokerQty > 0) {
      const stopQty = parseQty(activeStop.qty);
      if (stopQty > 0 && stopQty !== brokerQty) {
        tradeIncidents.push({
          code: "BROKER_DB_MISMATCH",
          severity: "WARN",
          tradeId: trade.id,
          symbol,
          detail: `Stop qty=${stopQty} != broker position qty=${brokerQty}`,
        });
      }
    }

    const detail: TradeAuditDetail = {
      tradeId: trade.id,
      symbol,
      side: side || String(trade.side),
      hasBrokerPosition: brokerQty > 0,
      brokerQty,
      hasActiveStop: !!activeStop,
      activeStopId: activeStop?.id,
      activeStopTif: activeStop?.time_in_force,
      incidents: tradeIncidents,
    };
    details.push(detail);

    if (tradeIncidents.length === 0) {
      protectedCount++;
    }
    allIncidents.push(...tradeIncidents);
  }

  // ─── Pass 2: Orphan broker positions ──────────────────────────────
  // Any broker position with qty > 0 that has NO matching DB open trade is
  // operationally invisible to the DB-driven audit above.  Catch them here
  // so they can never silently escape protection accounting.
  const unmatchedBrokerPositions: string[] = [];

  for (const pos of brokerPositions) {
    const symbol = normalizeTicker(pos.symbol);
    if (!symbol) continue;
    const brokerQty = parseQty(pos.qty);
    if (brokerQty === 0) continue;
    if (openTradeSymbols.has(symbol)) continue; // already covered in Pass 1

    unmatchedBrokerPositions.push(symbol);

    const symbolOrders = ordersBySymbol.get(symbol) || [];
    // Infer side from signed qty: Alpaca returns negative qty for shorts
    const rawQty = Number(pos.qty ?? 0);
    const posSide: "LONG" | "SHORT" = rawQty < 0 ? "SHORT" : "LONG";

    const found = findProtectiveStopOrder({
      ticker: symbol,
      tradeSide: posSide,
      openOrders: symbolOrders,
    });
    const activeStop = found ? symbolOrders.find((o) => o.id === found.id) : undefined;

    const orphanIncidents: ProtectionIncident[] = [];

    orphanIncidents.push({
      code: "BROKER_DB_MISMATCH",
      severity: "CRITICAL",
      tradeId: `orphan:${symbol}`,
      symbol,
      detail: `Broker has ${brokerQty} share(s) of ${symbol} (${posSide}) but no matching OPEN DB trade. avg_entry=${
        pos.avg_entry_price ?? "?"
      }`,
    });

    if (!activeStop) {
      orphanIncidents.push({
        code: "MISSING_STOP",
        severity: "CRITICAL",
        tradeId: `orphan:${symbol}`,
        symbol,
        detail: `Orphan broker position ${symbol} has no active protective stop`,
      });
    } else {
      const tif = (activeStop.time_in_force || "").toLowerCase();
      if (tif === "day") {
        orphanIncidents.push({
          code: "STOP_DAY_TIF",
          severity: dayTifSeverity(marketOpen),
          tradeId: `orphan:${symbol}`,
          symbol,
          detail: `Orphan stop order ${activeStop.id} has time_in_force=day`,
        });
      }
    }

    allIncidents.push(...orphanIncidents);
    // Orphans are never counted as "protected" — they lack an operational trade record
    details.push({
      tradeId: `orphan:${symbol}`,
      symbol,
      side: posSide,
      hasBrokerPosition: true,
      brokerQty,
      hasActiveStop: !!activeStop,
      activeStopId: activeStop?.id,
      activeStopTif: activeStop?.time_in_force,
      incidents: orphanIncidents,
      isOrphan: true,
    });
  }

  const criticalCount = allIncidents.filter((i) => i.severity === "CRITICAL").length;

  // Symbols that need operational attention right now
  const protectionBlockerSymbols = Array.from(
    new Set(
      allIncidents
        .filter((i) => i.severity === "CRITICAL")
        .map((i) => i.symbol)
    )
  );

  const brokerPositionCount = Array.from(posBySymbol.values()).filter(
    (p) => parseQty(p.qty) > 0
  ).length;

  return {
    ok: criticalCount === 0,
    auditedAt: now,
    tradeCount: openTrades.length,
    protectedCount,
    incidentCount: allIncidents.length,
    criticalCount,
    incidents: allIncidents,
    details,
    brokerPositionCount,
    matchedTradeCount: openTradeSymbols.size,
    unmatchedBrokerPositions,
    protectionBlockerSymbols,
  };
}
