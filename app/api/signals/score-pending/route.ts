import { NextResponse } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { scoreSignalWithAI, RawSignal, ScoredSignal } from "@/lib/aiScoring";
import { parseAiTradePlan } from "@/lib/tradePlan";
import { shouldQualify } from "@/lib/aiQualify";
import { readSignals, writeSignals, StoredSignal } from "@/lib/jsonDb";
import { touchHeartbeat } from "@/lib/aiHeartbeat";
import { bumpTodayFunnel } from "@/lib/funnelRedis";

function etDate(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
}

function isPending(s: any) {
  const st = String(s?.status || "").toUpperCase();
  return st === "PENDING" || st === "";
}

export async function POST(req: Request) {
  const cronToken = req.headers.get("x-cron-token") || "";
  const autoToken = req.headers.get("x-auto-entry-token") || "";

  const okCron = !!process.env.CRON_TOKEN && cronToken === process.env.CRON_TOKEN;
  const okAuto = !!process.env.AUTO_ENTRY_TOKEN && autoToken === process.env.AUTO_ENTRY_TOKEN;
  if (!okCron && !okAuto) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(25, Number(url.searchParams.get("limit") || "8")));
  const sinceHours = Math.max(1, Math.min(96, Number(url.searchParams.get("sinceHours") || "48")));
  const now = new Date();
  const sinceMs = now.getTime() - sinceHours * 60 * 60 * 1000;

  const runId = req.headers.get("x-run-id") || `score-pending-${Date.now()}`;
  const runSource = req.headers.get("x-run-source") || "unknown";

  const signals = await readSignals();

  // Recent first
  const recent = (signals || [])
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .filter((s: any) => {
      const t = new Date(String(s?.createdAt || 0)).getTime();
      return Number.isFinite(t) && t >= sinceMs;
    });

  const pending = recent.filter(isPending);
  const picked = pending.slice(0, limit);

  const updated: StoredSignal[] = [];
  const errors: any[] = [];

  for (const s of picked) {
    try {
      const raw: RawSignal = {
        id: String(s.id),
        ticker: String(s.ticker),
        side: s.side,
        entryPrice: Number(s.entryPrice),
        stopPrice: Number(s.stopPrice),
        targetPrice: Number(s.targetPrice),
        timeframe: s.timeframe || "1Min",
        source: s.source || "unknown",
        createdAt: s.createdAt,
        vwap: (s as any).vwap,
        pullbackPct: (s as any).pullbackPct,
        trendScore: (s as any).trendScore,
        liquidityScore: (s as any).liquidityScore,
        playbookScore: (s as any).playbookScore,
        volumeScore: (s as any).volumeScore,
        catalystScore: (s as any).catalystScore,
        reasoning: s.reasoning,
      };

      const scoredResult = await scoreSignalWithAI(raw);
      if (!scoredResult.ok) {
        const fail: StoredSignal = {
          ...(s as any),
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
          updatedAt: new Date().toISOString(),
        };
        updated.push(fail);
        continue;
      }

      const scored: ScoredSignal = scoredResult.scored;

      // Optional: parse trade plan if present
      const tradePlan = parseAiTradePlan({
        text: scored.aiSummary ?? "",
        score: scored.totalScore ?? scored.aiScore ?? 0,
        side: raw.side,
        entryPrice: raw.entryPrice,
        stopPrice: raw.stopPrice,
      });

      const qualified = shouldQualify({
        score: scored.totalScore ?? scored.aiScore ?? null,
        grade: (scored.aiGrade as any) ?? null,
      });

      const final: StoredSignal = {
        ...(s as any),
        ...scored,
        tradePlan,
        qualified,
        shownInApp: true,
        status: "SCORED",
        score: scored.totalScore ?? scored.aiScore ?? null,
        grade: (scored.aiGrade as any) ?? null,
        updatedAt: new Date().toISOString(),
      };

      updated.push(final);

      await bumpTodayFunnel({ gptScored: 1 });
      await touchHeartbeat();
    } catch (err: any) {
      errors.push({ id: s?.id, ticker: s?.ticker, message: err?.message || String(err) });
    }
  }

  if (updated.length) {
    // Merge updates back into array
    const byId = new Map<string, StoredSignal>();
    for (const u of updated) byId.set(String(u.id), u);

    const merged = (signals || []).map((x: any) => byId.get(String(x?.id)) || x);
    await writeSignals(merged);
  }

  return NextResponse.json(
    {
      ok: true,
      etDate: etDate(),
      runId,
      runSource,
      sinceHours,
      limit,
      counts: {
        total: (signals || []).length,
        recent: recent.length,
        pending: pending.length,
        picked: picked.length,
        updated: updated.length,
        errors: errors.length,
      },
      updated: updated.slice(0, 10).map((s) => ({
        id: s.id,
        ticker: s.ticker,
        status: s.status,
        score: (s as any).score ?? (s as any).aiScore,
        grade: (s as any).grade ?? (s as any).aiGrade,
        qualified: (s as any).qualified,
      })),
      errors: errors.slice(0, 10),
    },
    { status: 200, headers: { "Cache-Control": "no-store" } }
  );
}
