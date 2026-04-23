import { NextResponse } from "next/server";
import { submitOrder } from "@/lib/alpaca";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import { fetchBrokerTruth } from "@/lib/broker/truth";
import {
  getOperationallyActiveTickers,
  isLegacyErrorNoiseTrade,
  isOperationallyActiveTrade,
  normalizedOperationalStatus,
} from "@/lib/trades/operational";
import { ProtectionStatus } from "@/lib/trades/protection";
import { getEtDateString, getEtDayBoundsMs } from "@/lib/time/etDate";

export const runtime = "nodejs";

type Direction = "LONG" | "SHORT";

export type TradeStatus =
  | "NEW"
  | "OPEN"
  | "BROKER_PENDING"
  | "BROKER_FILLED"
  | "BROKER_REJECTED"
  | "BROKER_ERROR"
  | "ERROR"
  | "DISABLED";

export type ManagementStatus =
  | "UNMANAGED"
  | "STOP_MOVED_TO_BREAKEVEN"
  | "PARTIAL_TAKEN_1R"
  | "PARTIAL_TAKEN_2R"
  | "TRAILING"
  | "CLOSED";

export interface IncomingTrade {
  ticker: string;
  side: Direction; // LONG / SHORT
  quantity: number;

  entryPrice: number;
  stopPrice: number;
  targetPrice?: number;

  reasoning?: string;
  source?: string;

  submitToBroker?: boolean;
  orderType?: "market" | "limit";
  timeInForce?: "day" | "gtc";

  // optional automation flags
  autoManage?: boolean;
  manageSizePct1?: number;
  manageSizePct2?: number;
}

export interface TradeRecord extends IncomingTrade {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: TradeStatus;
  qty?: number;
  filledQty?: number;
  avgFillPrice?: number;

  // Broker info
  brokerOrderId?: string;
  brokerStatus?: string;
  brokerRaw?: any;
  alpacaOrderId?: string;
  alpacaStatus?: string;
  stopOrderId?: string;
  takeProfitOrderId?: string;
  error?: string;

  // Protection integrity model
  protectionStatus?: ProtectionStatus;
  protectionVerifiedAt?: string;
  protectionIssue?: string;
  lastProtectionCheckAt?: string;

  // Closure fields (should only be set when status is CLOSED/ERROR, not when position exists)
  closedAt?: string;
  finalizedAt?: string;
  closeReason?: string;
  realizedPnL?: number;
  realizedR?: number;

  // Auto-management info
  autoEntryStatus?: "OPEN" | "CLOSED"; // Track auto-entry status separately
  managementStatus?: ManagementStatus;
  lastAutoPrice?: number;
  lastAutoCheckAt?: string;

  // Disabled metadata
  disabledAt?: string;
  disableReason?: string;

  // legacy/extended management config (kept for compatibility)
  management?: {
    enabled: boolean;
    tp1R: number;
    tp2R: number;
    tp1SizePct: number;
    tp2SizePct: number;
    tp1Done?: boolean;
    tp2Done?: boolean;
    movedToBE?: boolean;
    lastPrice?: number;
    lastUpdated?: string;
  };
}

function mapDirection(side: Direction): "buy" | "sell" {
  return side === "LONG" ? "buy" : "sell";
}

function mapQty(trade: TradeRecord) {
  const explicitQty = trade.qty ?? trade.quantity;
  if (typeof explicitQty === "number" && explicitQty > 0) {
    return explicitQty;
  }
  const brokerQty = Number(trade.brokerRaw?.qty ?? trade.brokerRaw?.quantity ?? 0);
  return brokerQty || null;
}

function mapFilledQty(trade: TradeRecord) {
  if (typeof trade.filledQty === "number") {
    return trade.filledQty;
  }
  const brokerFilled = Number(trade.brokerRaw?.filled_qty ?? trade.brokerRaw?.filledQty ?? 0);
  return brokerFilled || null;
}

function mapAvgFillPrice(trade: TradeRecord) {
  if (typeof trade.avgFillPrice === "number") {
    return trade.avgFillPrice;
  }
  const rawAvg = trade.brokerRaw?.filled_avg_price ?? trade.brokerRaw?.avg_fill_price;
  if (rawAvg != null) {
    const num = Number(rawAvg);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const statusParam = url.searchParams.get("status") ?? undefined;
    const limitParam = url.searchParams.get("limit");
    const orderParam = url.searchParams.get("order") ?? "desc";
    const viewParam = String(url.searchParams.get("view") || "").toLowerCase();
    const rangeParam = String(url.searchParams.get("range") || "").toLowerCase();
    const includeLegacyErrorsParam = String(url.searchParams.get("includeLegacyErrors") || "").toLowerCase();
    const includeLegacyErrors = includeLegacyErrorsParam === "1" || includeLegacyErrorsParam === "true";

    // Parse limit with validation
    let limit = 1000;
    if (limitParam) {
      const parsed = parseInt(limitParam, 10);
      if (!isNaN(parsed) && parsed > 0) {
        limit = Math.min(parsed, 5000);
      }
    }

    // Normalize order
    const order = orderParam === "asc" ? "asc" : "desc";

    // Read all trades
    let trades = await readTrades<TradeRecord>();

    // Always exclude DISABLED trades (they are archived/cleaned up)
    trades = trades.filter((trade) => trade.status !== "DISABLED");

    // ─── ET-Today Range Filtering ─────────────────────────────────────
    // range=today filters to true ET-today scope for operational visibility
    let etDateUsed: string | null = null;
    if (rangeParam === "today") {
      etDateUsed = getEtDateString();
      const { startMs, endMs } = getEtDayBoundsMs(etDateUsed);
      
      trades = trades.filter((trade) => {
        // Use createdAt as primary timestamp, fall back to updatedAt
        const ts = trade.createdAt || trade.updatedAt;
        if (!ts) return false;
        const tsMs = Date.parse(ts);
        if (!Number.isFinite(tsMs)) return false;
        return tsMs >= startMs && tsMs < endMs;
      });
      
      // Debug log for ET-day filtering
      console.log("[trades] range=today filter applied", {
        etDateUsed,
        startMs,
        endMs,
        matchedCount: trades.length,
      });
    }

    // Apply filtering by status
    if (statusParam && statusParam !== "ALL") {
      trades = trades.filter((trade) => trade.status === statusParam);
    } else {
      // Default view keeps history but suppresses ticker-duplicate legacy ERROR rows
      // that hide currently active OPEN/AUTO_PENDING records during investigations.
      if (!includeLegacyErrors) {
        const activeTickers = getOperationallyActiveTickers(trades);
        trades = trades.filter((trade) => !isLegacyErrorNoiseTrade(trade, activeTickers));
      }
    }

    if (viewParam === "operational") {
      trades = trades.filter((trade) => isOperationallyActiveTrade(trade));

      // Deduplicate by ticker: show only the canonical record when multiple OPEN trades
      // exist for the same broker position (e.g. AUTO trade + ghost broker_backfill).
      const canonicalMap = new Map<string, TradeRecord>();
      for (const t of trades) {
        const sym = String((t as any).symbol ?? t.ticker ?? "").toUpperCase();
        if (!sym) { canonicalMap.set(t.id, t); continue; }
        const existing = canonicalMap.get(sym);
        if (!existing) { canonicalMap.set(sym, t); continue; }
        const richness = (x: any) =>
          (x?.signalId ? 8 : 0) +
          (x?.source === "AUTO" || x?.source === "AUTO-ENTRY" ? 4 : 0) +
          ((x?.stopOrderId || x?.alpacaStopOrderId) ? 2 : 0) +
          (x?.aiScore ? 1 : 0);
        if (richness(t) > richness(existing)) canonicalMap.set(sym, t);
      }
      trades = Array.from(canonicalMap.values());
    }

    // Apply sorting by createdAt
    trades.sort((a, b) => {
      const dateA = new Date(a.createdAt).getTime();
      const dateB = new Date(b.createdAt).getTime();
      return order === "desc" ? dateB - dateA : dateA - dateB;
    });

    // Capture counts before limiting
    const total = await readTrades<TradeRecord>();
    const totalCount = total.length;
    const filteredCount = trades.length;

    // Apply limit
    trades = trades.slice(0, limit);

    // Broker truth validation: repair OPEN trades that have closure fields set
    // (This can happen if reconciliation was interrupted or data was corrupted)
    let brokerTruth;
    try {
      brokerTruth = await fetchBrokerTruth();
    } catch (err) {
      console.warn("[trades] Could not fetch broker truth for validation", err);
      brokerTruth = null;
    }

    if (brokerTruth && !brokerTruth.error) {
      const posBySym = new Map<string, any>();
      for (const p of brokerTruth.positions) {
        const sym = String(p.symbol || "").toUpperCase();
        if (sym) posBySym.set(sym, p);
      }

      // Repair any OPEN trades that have closure artifacts when broker position exists
      for (const trade of trades) {
        if (trade.status === "OPEN") {
          const ticker = String(trade.ticker || "").toUpperCase();
          const hasBrokerPos = ticker && posBySym.has(ticker);
          const hasClosureFields = trade.closedAt || trade.error || trade.closeReason;

          if (hasBrokerPos && hasClosureFields) {
            // Broker truth wins: clear closure fields
            trade.closedAt = undefined;
            trade.finalizedAt = undefined;
            trade.closeReason = undefined;
            trade.error = undefined;
            (trade as any).realizedPnL = undefined;
            (trade as any).realizedR = undefined;
            console.log(
              "[trades] Repaired trade with broker position but closure artifacts",
              { id: trade.id, ticker }
            );
          }
        }
      }
    }

    // Map quantity fields
    const serialized = trades.map((trade) => {
      const t = trade as any;
      // AI shape consistency: top-level aiScore is authoritative.
      // If nested ai object has score=0 but aiScore is non-zero, mirror the top-level value.
      let aiShape: Record<string, any> | undefined = undefined;
      if (t?.ai && typeof t.ai === "object") {
        const topScore = Number.isFinite(Number(t.aiScore)) ? Number(t.aiScore) : null;
        const nestedScore = Number.isFinite(Number(t.ai.score)) ? Number(t.ai.score) : null;
        const finalScore = topScore ?? nestedScore;
        aiShape = {
          ...t.ai,
          score: finalScore,
          grade: t.ai.grade ?? t.aiGrade ?? null,
          tier: t.ai.tier ?? t.tier ?? null,
        };
      }

      return {
        ...trade,
        // Canonical symbol field: symbol is authoritative, ticker is legacy alias
        symbol: t.symbol ?? t.ticker ?? null,
        qty: mapQty(trade),
        filledQty: mapFilledQty(trade),
        avgFillPrice: mapAvgFillPrice(trade),
        normalizedStatus: normalizedOperationalStatus(trade),
        operationallyActive: isOperationallyActiveTrade(trade),
        ...(aiShape !== undefined ? { ai: aiShape } : {}),
      };
    });

    return NextResponse.json({
      ok: true,
      trades: serialized,
      meta: {
        total: totalCount,
        filtered: filteredCount,
        limit,
        order,
        status: statusParam ?? null,
        view: viewParam || "default",
        range: rangeParam || null,
        etDateUsed,
        includeLegacyErrors,
      },
    });
  } catch (err: any) {
    console.error("[trades] GET error", err);
    return NextResponse.json(
      {
        ok: false,
        error: "Failed to load trades",
        detail: err?.message ?? String(err),
      },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as IncomingTrade;

    const now = new Date().toISOString();
    let status: TradeStatus = "NEW";
    let brokerOrder: any;
    let error: string | undefined;

    if (body.submitToBroker) {
      try {
        status = "BROKER_PENDING";

        brokerOrder = await submitOrder({
          symbol: body.ticker,
          qty: body.quantity,
          side: mapDirection(body.side),
          type: body.orderType ?? "market",
          timeInForce: body.timeInForce ?? "day",
        });

        status =
          brokerOrder.status === "filled" || brokerOrder.status === "partially_filled"
            ? "BROKER_FILLED"
            : "BROKER_PENDING";
      } catch (err: any) {
        status = "BROKER_ERROR";
        error = err.message;
      }
    }

    const newTrade: TradeRecord = {
      ...body,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      status,
      brokerOrderId: brokerOrder?.id,
      brokerStatus: brokerOrder?.status,
      brokerRaw: brokerOrder ? { id: brokerOrder.id, status: brokerOrder.status } : undefined,
      error,
      // Seed management fields for the auto-management engine
      managementStatus: "UNMANAGED",
      lastAutoPrice: body.entryPrice,
      lastAutoCheckAt: now,
      management: body.autoManage
        ? {
            enabled: true,
            tp1R: 1,
            tp2R: 2,
            tp1SizePct: body.manageSizePct1 ?? 0.5,
            tp2SizePct: body.manageSizePct2 ?? 1.0,
            tp1Done: false,
            tp2Done: false,
            movedToBE: false,
            lastUpdated: now,
          }
        : undefined,
    };

    const trades = await readTrades<TradeRecord>();
    await writeTrades([newTrade, ...trades]);

    return NextResponse.json({ ok: true, trade: newTrade }, { status: 201 });
  } catch (err: any) {
    console.error("[trades] POST error", err);
    return NextResponse.json(
      {
        ok: false,
        error: "Failed to create trade",
        detail: err?.message ?? String(err),
      },
      { status: 500 }
    );
  }
}
