import { NextResponse } from "next/server";
import { formatAiSummary, gradeFromScore, AiGrade } from "@/lib/aiScoring";

const INSUFFICIENT_BARS_DEMOTE_v1 = true;
import { readSignals, writeSignals, StoredSignal } from "@/lib/jsonDb";

const PLACEHOLDER_SUMMARIES = new Set([
  "AI scoring pending",
  "No summary provided by AI.",
  "No detailed summary returned.",
  "Scored F (0). No detailed summary returned.",
  "Scored F (0.0). No detailed summary returned.",
]);

function isPlaceholderSummary(value?: string) {
  if (!value) return true;
  const trimmed = value.trim();
  return trimmed.length === 0 || PLACEHOLDER_SUMMARIES.has(trimmed);
}

function isAuthorized(req: Request) {
  const cookie = req.headers.get("cookie") ?? "";
  if (cookie.split(";").some((part) => part.trim() === "auth_pin=1")) {
    return true;
  }
  const pinHeader = req.headers.get("x-app-pin") ?? req.headers.get("authorization") ?? "";
  const pin = pinHeader.replace(/^Bearer\s+/i, "").trim();
  if (pin && process.env.APP_PIN && pin === process.env.APP_PIN) {
    return true;
  }
  return false;
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const signals = await readSignals();
  let updated = 0;
  const reconciled = signals.map((signal: StoredSignal) => {
    const aiScoreNum = Number(signal.aiScore ?? 0);
    const hasScore = Number.isFinite(aiScoreNum) && aiScoreNum > 0;
    const summaryText =
      typeof signal.aiSummary === "string" ? signal.aiSummary.trim() : "";
    const hasSummary = summaryText.length > 0 && !isPlaceholderSummary(summaryText);
    const shouldFlipStatus = signal.status === "PENDING" && hasScore;
    const shouldFixSummary =
        signal.status === "SCORED" &&
        (!hasSummary || signal.aiSummary === "No summary provided by AI.");

      const insufficientBars =
        typeof signal.aiSummary === "string" &&
        signal.aiSummary.toLowerCase().includes("insufficient recent bars");

      const missingScore =
        signal.aiScore == null ||
        !Number.isFinite(Number(signal.aiScore)) ||
        Number(signal.aiScore) <= 0;

      const shouldDemoteInsufficient = signal.status === "SCORED" && (insufficientBars || missingScore);


    if (!shouldFlipStatus && !shouldFixSummary && !shouldDemoteInsufficient) {
        return signal;
      }

    updated += 1;

    const grade =
      typeof signal.aiGrade === "string" && signal.aiGrade.trim()
        ? (signal.aiGrade.trim() as AiGrade)
        : gradeFromScore(aiScoreNum);
    const summary = hasSummary
      ? summaryText
      : formatAiSummary(grade, aiScoreNum);

    return {
        ...signal,
        status: shouldDemoteInsufficient ? "PENDING" : (shouldFlipStatus ? "SCORED" : signal.status),
        shownInApp: shouldDemoteInsufficient ? false : (signal as any).shownInApp,
        qualified: shouldDemoteInsufficient ? false : (signal as any).qualified,
        aiScore: shouldDemoteInsufficient ? null : aiScoreNum,
        aiGrade: shouldDemoteInsufficient ? null : grade,
        score: shouldDemoteInsufficient ? null : (signal as any).score,
        grade: shouldDemoteInsufficient ? null : (signal as any).grade,
        totalScore: shouldDemoteInsufficient ? null : (signal as any).totalScore,
        aiSummary: shouldDemoteInsufficient ? summaryText : summary,
      };
  });

  if (updated > 0) {
    await writeSignals(reconciled);
  }

  return NextResponse.json({
    ok: true,
    scanned: signals.length,
    updated,
  });
}
