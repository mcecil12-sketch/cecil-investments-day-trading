import { NextResponse } from "next/server";
import { readTrades, writeTrades } from "@/lib/tradesStore";
import { finalizeTradeClose } from "@/lib/trades/finalizeClose";
import { notify } from "@/lib/notifications/notify";
import { buildTradeClosedPayload } from "@/lib/notifications/tradeClose";

export const dynamic = "force-dynamic";

function isAuthed(req: Request) {
  const tok = req.headers.get("x-cron-token") || "";
  return Boolean(process.env.CRON_TOKEN && tok && tok === process.env.CRON_TOKEN);
}

export async function POST(req: Request) {
  const runSource = req.headers.get("x-run-source") || "unknown";
  const runId = req.headers.get("x-run-id") || "";
  const marketLoopOnly = process.env.FINALIZE_MARKET_LOOP_ONLY !== "0";
  const allowedSources = (process.env.FINALIZE_ALLOWED_SOURCES || "github-actions,terminal")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!isAuthed(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized", runSource, runId }, { status: 401 });
  }

  if (!allowedSources.includes(runSource)) {
    return NextResponse.json(
      { ok: false, error: "forbidden_run_source", runSource, allowed: allowedSources, runId },
      { status: 403 }
    );
  }

  if (marketLoopOnly && runSource !== "github-actions") {
    return NextResponse.json({ ok: false, error: "market_loop_only", runSource, runId }, { status: 403 });
  }

  const url = new URL(req.url);
  const tickers = (url.searchParams.get("tickers") || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const rawLimit = Number(url.searchParams.get("limit") || "25");
  const effectiveLimit = Math.min(50, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 25));

  const trades = await readTrades();
  const closedFilter = (t: any) => String(t.status || "").toUpperCase() === "CLOSED";
  const candidates = tickers.length
    ? trades
        .filter(
          (t: any) =>
            closedFilter(t) &&
            (t.realizedPnL == null || t.realizedR == null) &&
            tickers.includes(String(t.ticker || "").toUpperCase())
        )
        .sort((a: any, b: any) => String(b.closedAt || "").localeCompare(String(a.closedAt || "")))
        .slice(0, effectiveLimit)
    : trades
        .filter(
          (t: any) =>
            closedFilter(t) &&
            !t.finalizedAt &&
            Boolean(t.closedAt)
        )
        .sort((a: any, b: any) => String(b.closedAt || "").localeCompare(String(a.closedAt || "")))
        .slice(0, effectiveLimit);

  const updates: any[] = [];
  const results: any[] = [];
  const finalizedTrades: any[] = [];
  let skippedReason = "";

  if (!candidates.length) {
    skippedReason = tickers.length ? "no_candidates_for_tickers" : "no_recent_unfinalized_closes";
    return NextResponse.json({
      ok: true,
      runSource,
      runId,
      skippedReason,
      effectiveLimit,
      checked: 0,
      updated: 0,
      results,
    });
  }

  for (const t of candidates) {
    const r = await finalizeTradeClose(t);
    results.push({ id: t.id, ticker: t.ticker, ...r });

    if (!r.ok) continue;

    if (r.action === "FINALIZED") {
      const finalizedTrade = {
        ...t,
        closePrice: (r as any).closePrice,
        realizedPnL: (r as any).realizedPnL,
        realizedR: (r as any).realizedR,
        closeReason: (r as any).closeReason,
        finalizedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      updates.push(finalizedTrade);
      finalizedTrades.push(finalizedTrade);
      continue;
    }

    if (r.action === "REOPENED") {
      updates.push({
        ...t,
        status: "OPEN",
        closedAt: null,
        closeReason: (r as any).reason,
        realizedPnL: null,
        realizedR: null,
        updatedAt: new Date().toISOString(),
      });
      continue;
    }

    if (r.action === "VOIDED") {
      updates.push({
        ...t,
        status: "DISABLED",
        autoEntryStatus: "AUTO_DISABLED",
        error: "voided_no_entry_fill",
        closeReason: (r as any).reason,
        realizedPnL: 0,
        realizedR: 0,
        updatedAt: new Date().toISOString(),
      });
      continue;
    }
  }

  if (updates.length) {
    const byId = new Map<string, any>(updates.map((u) => [String(u.id), u]));
    const merged = trades.map((t: any) => byId.get(String(t.id)) || t);
    await writeTrades(merged);
  }

  // Send TRADE_CLOSED notifications for finalized trades
  const notificationResults: any[] = [];
  for (const trade of finalizedTrades) {
    try {
      const { title, message } = buildTradeClosedPayload(trade);
      
      const notifyResult = await notify({
        type: "TRADE_CLOSED",
        tradeId: trade.id,
        ticker: trade.ticker,
        paper: true, // Paper-first: these are paper trades
        title,
        message,
        tier: "B",
        dedupeKey: `notify:dedupe:v1:trade_closed:${trade.id}`,
        dedupeTtlSec: 86400, // 24 hours
      });
      
      notificationResults.push({
        tradeId: trade.id,
        ticker: trade.ticker,
        sent: notifyResult.sent,
        skippedReason: notifyResult.skippedReason,
      });
      
      if (notifyResult.sent) {
        console.log("[finalize-closes] TRADE_CLOSED notification sent", {
          tradeId: trade.id,
          ticker: trade.ticker,
        });
      }
    } catch (err) {
      console.error("[finalize-closes] notification error", {
        tradeId: trade.id,
        ticker: trade.ticker,
        error: String(err),
      });
      notificationResults.push({
        tradeId: trade.id,
        ticker: trade.ticker,
        sent: false,
        skippedReason: "notification_exception",
      });
    }
  }

  return NextResponse.json({
    ok: true,
    runSource,
    runId,
    skippedReason,
    effectiveLimit,
    checked: candidates.length,
    updated: updates.length,
    finalized: finalizedTrades.length,
    finalizedTrades: finalizedTrades.map((t) => ({ id: t.id, ticker: t.ticker })),
    notificationsSent: notificationResults.filter((n) => n.sent).length,
    notifications: notificationResults,
    results,
  });
}
