import { NextResponse } from "next/server";
import { readSignals, writeSignals } from "@/lib/jsonDb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RepairResult {
  ok: boolean;
  checked: number;
  fixed: number;
  fixedInsufficientBars: number;
  fixedParseFailed: number;
  sample: Array<{
    id: string;
    ticker: string;
    status: string;
    error?: string;
    skipReason?: string;
    aiSummary: string;
  }>;
  error?: string;
}

export async function POST(req: Request): Promise<NextResponse<RepairResult>> {
  // Gate by x-cron-token
  const token = req.headers.get("x-cron-token") || "";
  const hasToken = !!process.env.CRON_TOKEN && token === process.env.CRON_TOKEN;

  if (!hasToken) {
    return NextResponse.json(
      {
        ok: false,
        error: "unauthorized",
        checked: 0,
        fixed: 0,
        fixedInsufficientBars: 0,
        fixedParseFailed: 0,
        sample: [],
      } as RepairResult,
      { status: 401 }
    );
  }

  try {
    const body = await req.json().catch(() => ({}));
    const limit = Math.max(1, Number((body as any)?.limit ?? 500));

    const signals = await readSignals();
    const nowIso = new Date().toISOString();

    let checked = 0;
    let fixed = 0;
    let fixedInsufficientBars = 0;
    let fixedParseFailed = 0;
    const sample: RepairResult["sample"] = [];

    // Scan for status=SCORED with aiScore==null
    const repaired = signals.map((signal: any) => {
      if (fixed >= limit) return signal;

      if (signal.status === "SCORED" && signal.aiScore == null) {
        checked++;

        const aiSummary = signal.aiSummary || "";
        const isInsufficientBars = aiSummary.toLowerCase().includes("insufficient recent bars");

        if (isInsufficientBars) {
          // Convert to ARCHIVED with skipReason
          signal.status = "ARCHIVED";
          signal.skipReason = "insufficient_bars";
          signal.qualified = false;
          signal.shownInApp = false;
          signal.scoredAt = nowIso;
          signal.updatedAt = nowIso;
          // Keep aiSummary as-is (already has the insufficient bars message)
          // Set aiScore=0 and aiGrade=F
          signal.aiScore = 0;
          signal.aiGrade = "F";
          // Clear other score aliases and fields
          delete signal.score;
          delete signal.grade;
          delete signal.totalScore;
          delete signal.tradePlan;
          delete signal.error;

          fixedInsufficientBars++;
          fixed++;

          if (sample.length < 10) {
            sample.push({
              id: signal.id,
              ticker: signal.ticker,
              status: signal.status,
              skipReason: signal.skipReason,
              aiSummary: signal.aiSummary,
            });
          }
        } else {
          // Convert to ERROR with parse_failed
          signal.status = "ERROR";
          signal.error = "parse_failed";
          signal.aiSummary = "parse_failed: null score detected / legacy conversion";
          signal.scoredAt = nowIso;
          signal.updatedAt = nowIso;
          // Set aiScore=0 and aiGrade=F (even though it's an error)
          signal.aiScore = 0;
          signal.aiGrade = "F";
          // Clear other score aliases and fields
          delete signal.score;
          delete signal.grade;
          delete signal.totalScore;
          delete signal.tradePlan;
          delete signal.qualified;
          delete signal.shownInApp;

          fixedParseFailed++;
          fixed++;

          if (sample.length < 10) {
            sample.push({
              id: signal.id,
              ticker: signal.ticker,
              status: signal.status,
              error: signal.error,
              aiSummary: signal.aiSummary,
            });
          }
        }
      }

      return signal;
    });

    // Write repaired signals back
    if (fixed > 0) {
      await writeSignals(repaired);
      console.log("[maintenance/repair-null-aiscore] fixed", {
        checked,
        fixed,
        fixedInsufficientBars,
        fixedParseFailed,
      });
    }

    return NextResponse.json(
      {
        ok: true,
        checked,
        fixed,
        fixedInsufficientBars,
        fixedParseFailed,
        sample,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[maintenance/repair-null-aiscore] error", err);
    return NextResponse.json(
      {
        ok: false,
        error: errMsg,
        checked: 0,
        fixed: 0,
        fixedInsufficientBars: 0,
        fixedParseFailed: 0,
        sample: [],
      },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
