import { NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SIGNALS = Number(process.env.MAX_SIGNALS ?? "4000");
import {
  scoreSignalWithAI,
  RawSignal,
  ScoredSignal,
  gradeFromScore,
  formatAiSummary,
  AiGrade,
} from "@/lib/aiScoring";
import { computeDirection } from "@/lib/scannerUtils";
import { parseAiTradePlan } from "@/lib/tradePlan";
import { sendPullbackAlert } from "@/lib/notify";
import { bumpTodayFunnel } from "@/lib/funnelRedis";
import { shouldQualify } from "@/lib/aiQualify";
import { readSignals, writeSignals, StoredSignal, normalizeAiDirectionForStorage } from "@/lib/jsonDb";
import { touchHeartbeat } from "@/lib/aiHeartbeat";
import { notifyOnce } from "@/lib/notifyOnce";

const PLACEHOLDER_SUMMARIES = new Set([
  "AI scoring pending",
  "No summary provided by AI.",
]);

function trimSignals(signals: any[]) {
  if (!Array.isArray(signals)) return signals;
  // retain only most recent N to avoid Upstash 10MB max request size
  if (signals.length <= MAX_SIGNALS) return signals;
  return signals.slice(Math.max(0, signals.length - MAX_SIGNALS));
}

function isPlaceholderSummary(value?: string) {
  if (!value) return true;
  const trimmed = value.trim();
  return trimmed.length === 0 || PLACEHOLDER_SUMMARIES.has(trimmed);
}

async function appendSignal(signal: StoredSignal) {
  const signals = await readSignals();
  signals.push(signal);
  await writeSignals(trimSignals(signals));
}

async function replaceSignal(scored: StoredSignal) {
  const signals = await readSignals();
  const idx = signals.findIndex((s) => s.id === scored.id);
  if (idx >= 0) {
    signals[idx] = scored;
  } else {
    signals.push(scored);
  }
  await writeSignals(trimSignals(signals));
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const minScoreParam = url.searchParams.get("minScore");
  const gradeParam = url.searchParams.get("grade");
  const statusParam = url.searchParams.get("status"); // e.g. PENDING, APPROVED, REJECTED
  const limitParam = url.searchParams.get("limit");

  const minScore = minScoreParam ? Number(minScoreParam) : undefined;
  const limit = limitParam ? Number(limitParam) : undefined;

  let signals = await readSignals();

  if (typeof minScore === "number" && !Number.isNaN(minScore)) {
    signals = signals.filter((s) => (s.aiScore ?? 0) >= minScore);
  }

  if (gradeParam) {
    signals = signals.filter((s) => s.aiGrade === gradeParam);
  }

  if (statusParam) {
    signals = signals.filter(
      (s: any) =>
        !s.status || // default to PENDING if missing
        (statusParam === "PENDING" && (s.status === "PENDING" || !s.status)) ||
        s.status === statusParam
    );
  }

  // Most recent first
  signals.sort(
    (a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  if (limit && limit > 0) {
    signals = signals.slice(0, limit);
  }

  return NextResponse.json({ signals });
}

export async function POST(req: Request) {
  const _t0 = Date.now();
  const _runId = req.headers.get("x-scan-run-id") || req.headers.get("x-run-id") || null;
  const _source = req.headers.get("x-scan-source") || req.headers.get("x-run-source") || null;
  let _where = "start";
  let _raw = "";
  let body: any = null;
  try {
    _where = "read_body";
    _raw = await req.text();
    _where = "parse_json";
    body = _raw ? JSON.parse(_raw) : null;
  } catch (err: any) {
    const msg = err?.message ?? "invalid_json";
    console.error("[signals] bad_json", { runId: _runId, source: _source, msg, head: (_raw || "").slice(0,240) });
    return NextResponse.json(
      { ok:false, error:"signals_bad_json", runId:_runId, source:_source, message: msg, bodyHead: (_raw||"").slice(0,240) },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  try {
    _where = "handler";

  const deferAI = req.headers.get("x-defer-ai") === "1";

  // Accept either 'ticker' or 'symbol' field (symbol as alias for ticker)
  const ticker = body.ticker || body.symbol;
  const {
    side,
    entryPrice,
    stopPrice,
    targetPrice,
    timeframe = "1Min",
    source = "VWAP_PULLBACK",
    rawMeta = {},
    reasoning,
  } = body;

  if (!ticker || !side || !entryPrice || !stopPrice || !targetPrice) {
    return NextResponse.json(
      { error: "Missing required fields for signal (ticker/symbol, side, entryPrice, stopPrice, targetPrice)." },
      { status: 400 }
    );
  }

  await bumpTodayFunnel({ signalsReceived: 1 });

  const now = new Date().toISOString();
  
  // Compute direction heuristically based on VWAP and trend if available
  const computedDirection = computeDirection({
    price: Number(entryPrice),
    vwap: rawMeta.vwap ? Number(rawMeta.vwap) : null,
    trend: rawMeta.trend ?? "FLAT",
  });

  // For directional signals (side=LONG/SHORT), set direction to match side
  // This ensures direction is never null for side signals
  const directionForSignal =
    side === "LONG" || side === "SHORT" ? side : computedDirection;

  const rawSignal: RawSignal = {
    id: rawMeta.id ?? `${ticker}-${now}`,
    ticker,
    side,
    direction: directionForSignal,
    entryPrice: Number(entryPrice),
    stopPrice: Number(stopPrice),
    targetPrice: Number(targetPrice),
    timeframe,
    source,
    createdAt: now,
    vwap: rawMeta.vwap,
    pullbackPct: rawMeta.pullbackPct,
    trendScore: rawMeta.trendScore,
    liquidityScore: rawMeta.liquidityScore,
    playbookScore: rawMeta.playbookScore,
    volumeScore: rawMeta.volumeScore,
    catalystScore: rawMeta.catalystScore,
    reasoning: reasoning ?? rawMeta.reasoning,
  };

  const placeholder: StoredSignal = {
    ...rawSignal,
    aiScore: 0,
    aiGrade: "F",
    aiSummary: "AI scoring pending",
    totalScore: 0,
    status: "PENDING",
    reasoning: rawSignal.reasoning ?? "AI scoring pending",
    score: 0,
    grade: "F",
    qualified: false,
    shownInApp: false,
    tradePlan: null,
  };

  await appendSignal(placeholder);

  if (deferAI) {
    return NextResponse.json(
      { ok: true, deferred: true, signal: placeholder },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }

  const placeholderScored: ScoredSignal = {
    ...placeholder,
    timeframe: placeholder.timeframe ?? "1Min",
    source: placeholder.source ?? "unknown",
    aiScore: placeholder.aiScore ?? 0,
    aiGrade: (placeholder.aiGrade ?? "F") as ScoredSignal["aiGrade"],
    aiSummary: placeholder.aiSummary ?? "AI scoring pending",
    totalScore: placeholder.totalScore ?? 0,
    stopPrice: rawSignal.stopPrice,
    targetPrice: rawSignal.targetPrice,
  };

  let scored: ScoredSignal = placeholderScored;
  let finalSignal: StoredSignal = placeholder;

  try {
    const scoredResult = await scoreSignalWithAI(rawSignal);
    if (!scoredResult.ok) {
      finalSignal = {
        ...placeholder,
        status: "ERROR",
        error: scoredResult.error,
        aiErrorReason: scoredResult.error,
        aiRawHead: scoredResult.rawHead,
        aiSummary: `AI parse failed (${scoredResult.reason})`,
        aiScore: null,
        aiGrade: null,
        totalScore: null,
        score: null,
        grade: null,
        qualified: false,
        shownInApp: false,
        reasoning: "AI parse failed",
      };
      await replaceSignal(finalSignal);
      return NextResponse.json({ signal: finalSignal });
    }

    scored = scoredResult.scored;
    if (scored.status === "SKIPPED") {
      finalSignal = {
        ...placeholder,
        ...scored,
        aiScore: null,
        aiGrade: null,
        totalScore: null,
        score: null,
        grade: null,
        status: "SKIPPED",
        qualified: false,
        shownInApp: false,
        reasoning: scored.aiSummary ?? placeholder.reasoning ?? "AI scoring skipped",
        aiDirection: normalizeAiDirectionForStorage(scored.aiDirection),
      };
      await replaceSignal(finalSignal);
      return NextResponse.json({ signal: finalSignal });
    }
    const safeScore = Number.isFinite(scored.aiScore ?? NaN)
      ? scored.aiScore!
      : null;
    const hasScore = safeScore != null;
    const gradeCandidate =
      typeof scored.aiGrade === "string" && scored.aiGrade.trim()
        ? (scored.aiGrade.trim() as AiGrade)
        : null;

    if (!hasScore || gradeCandidate == null) {
      throw new Error("AI scoring response missing score or grade");
    }

    const rawSummary =
      typeof scored.aiSummary === "string" ? scored.aiSummary.trim() : "";
    const safeSummary =
      rawSummary.length > 0 && !isPlaceholderSummary(rawSummary)
        ? rawSummary
        : formatAiSummary(gradeCandidate, safeScore);
    const totalScoreValue =
      typeof scored.totalScore === "number" && Number.isFinite(scored.totalScore)
        ? scored.totalScore
        : safeScore;
    const tradePlan =
      scored.tradePlan ??
      parseAiTradePlan({
        text: scored.aiSummary ?? "",
        score: safeScore ?? 0,
        side,
        entryPrice: Number(entryPrice),
        stopPrice: Number(stopPrice),
        liquidityTag: rawMeta?.liquidityTag ?? rawMeta?.liquidity?.tag,
      });
    finalSignal = {
      ...placeholder,
      ...scored,
      aiScore: safeScore,
      aiGrade: gradeCandidate,
      aiSummary: safeSummary,
      totalScore: totalScoreValue,
      status: "SCORED",
      score: safeScore,
      grade: gradeCandidate,
      reasoning: placeholder.reasoning ?? safeSummary,
      shownInApp: true,
      tradePlan,
      direction: side === "LONG" || side === "SHORT" ? side : finalSignal.direction,
      aiDirection: normalizeAiDirectionForStorage(scored.aiDirection),
    };
    await replaceSignal(finalSignal);
    await touchHeartbeat();

    const minScore = Number(process.env.APPROVAL_MIN_AI_SCORE ?? "7.5");
    const aiScore = typeof finalSignal.aiScore === "number" ? finalSignal.aiScore : 0;
    const qualified =
      typeof finalSignal.qualified === "boolean"
        ? finalSignal.qualified
        : shouldQualify({
            score: finalSignal.aiScore ?? null,
            grade: finalSignal.aiGrade ?? null,
          });
    finalSignal = {
      ...finalSignal,
      qualified,
    };
    const isApprovalQueueItem = finalSignal.status === "SCORED" && aiScore >= minScore;

    if (isApprovalQueueItem) {
      const dedupeKey = `notify:approval:v1:${finalSignal.id}`;
      const once = await notifyOnce(dedupeKey);
      if (once.shouldNotify) {
        await sendPullbackAlert({
          ticker: finalSignal.ticker,
          side: finalSignal.side,
          entryPrice: finalSignal.entryPrice,
          stopPrice: finalSignal.stopPrice ?? null,
          score: aiScore,
          reason: `In approval queue (score ≥ ${minScore}).`,
        });
      } else {
        console.log("[notify] skipped approval alert (deduped)", {
          id: finalSignal.id,
          reason: once.reason,
        });
      }
    }
  } catch (err: any) {
    console.error("AI scoring failed:", err);
    const message = err?.message ?? "AI scoring failed";
    finalSignal = {
      ...placeholder,
      status: "ERROR",
      error: message,
      score: placeholder.aiScore ?? 0,
      grade: placeholder.aiGrade ?? "F",
      qualified: false,
      shownInApp: false,
      reasoning: placeholder.reasoning ?? "AI scoring failed",
    };
    await replaceSignal(finalSignal);
    return NextResponse.json({ signal: finalSignal });
  }

  console.log("[signals] New signal scored", {
    ticker: scored.ticker,
    score: scored.aiScore,
    grade: scored.aiGrade,
  });

  const grade = finalSignal.aiGrade ?? finalSignal.grade ?? null;
  const qualified =
    typeof finalSignal.qualified === "boolean"
      ? finalSignal.qualified
      : shouldQualify({
          score: finalSignal.aiScore ?? null,
          grade,
        });
  try {
    if (finalSignal.status === "SCORED") {
      await bumpTodayFunnel({ gptScored: 1 });
    }
    if (finalSignal.status !== "ARCHIVED") {
      await bumpTodayFunnel({ shownInApp: 1 });
    }
    if (qualified) {
      await bumpTodayFunnel({ qualified: 1 });
    }
  } catch (err) {
    console.log("[funnel] bump failed (non-fatal)", err);
  }

  if (scored.aiGrade === "A" || (scored.aiScore ?? 0) >= 9) {
    try {
      await sendPullbackAlert(scored);
    } catch (err) {
      console.error("[signals] sendPullbackAlert failed", err);
    }
  }

  return NextResponse.json({ signal: finalSignal });
  } catch (err: any) {
    const msg = err?.message ?? "signals_fatal";
    const stack = (err?.stack ? String(err.stack) : "");
    console.error("[signals] fatal", { where: _where, runId: _runId, source: _source, msg, stackHead: stack.slice(0,800) });
    return NextResponse.json(
      {
        ok: false,
        error: "signals_fatal",
        where: _where,
        runId: _runId,
        source: _source,
        message: msg,
        stackHead: stack.slice(0,800),
        bodyHead: (_raw || "").slice(0,240),
        ms: Date.now() - _t0,
      },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
