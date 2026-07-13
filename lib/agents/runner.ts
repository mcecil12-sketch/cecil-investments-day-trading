import { prisma } from "@/lib/prisma";
import { runRelativeStrengthAgent, type RelativeStrengthEntry } from "@/lib/agents/relativeStrength";

function formatPercent(value: number | null): string {
  if (value == null) return "unknown";
  return `${(value * 100).toFixed(1)}%`;
}

interface DraftActionItem {
  priority: number;
  action: string;
  rationale: string;
  expectedImpact: string;
  accountId: string | null;
}

function underperformerItem(entry: RelativeStrengthEntry, priority: number): DraftActionItem {
  return {
    priority,
    action: `Review ${entry.symbol} — trailing relative strength`,
    rationale: `Score ${entry.score}/100 (${formatPercent(entry.relativeScore / 100)} vs S&P 500), 52-week momentum ${formatPercent(entry.momentum)}.`,
    expectedImpact: "Reduces drag from a persistently lagging position.",
    accountId: entry.accountIds.length === 1 ? entry.accountIds[0] : null,
  };
}

function candidateItem(entry: RelativeStrengthEntry, priority: number): DraftActionItem {
  return {
    priority,
    action: `Watch ${entry.symbol} — building relative strength`,
    rationale: `Score ${entry.score}/100, 52-week momentum ${formatPercent(entry.momentum)}, trading ${entry.aboveSma50 ? "above" : "below"} its 50-day average.`,
    expectedImpact: "Early signal for a potential add if strength continues.",
    accountId: entry.accountIds.length === 1 ? entry.accountIds[0] : null,
  };
}

function topHoldingItem(entry: RelativeStrengthEntry, priority: number): DraftActionItem {
  return {
    priority,
    action: `Hold ${entry.symbol} — leading relative strength`,
    rationale: `Score ${entry.score}/100 (${formatPercent(entry.relativeScore / 100)} vs S&P 500), 52-week momentum ${formatPercent(entry.momentum)}.`,
    expectedImpact: "Confirms the position is still earning its place in the portfolio.",
    accountId: entry.accountIds.length === 1 ? entry.accountIds[0] : null,
  };
}

export interface RelativeStrengthRunResult {
  runId: string;
  status: "COMPLETE" | "FAILED";
  output?: Awaited<ReturnType<typeof runRelativeStrengthAgent>>;
  error?: string;
}

/**
 * Runs the Relative Strength agent and persists its AgentRun + derived
 * ActionItems. Shared by the manual API route and the auto-trigger fired
 * after a successful import, so both paths save results identically.
 */
export async function runAndPersistRelativeStrength(): Promise<RelativeStrengthRunResult> {
  const run = await prisma.agentRun.create({
    data: { agentType: "RELATIVE_STRENGTH", status: "RUNNING" },
  });

  try {
    const output = await runRelativeStrengthAgent();

    const draftItems: DraftActionItem[] = [
      ...output.underperformers.map((e, i) => underperformerItem(e, i + 1)),
      ...output.candidates.map((e, i) => candidateItem(e, output.underperformers.length + i + 1)),
      ...output.topHoldings.map((e, i) =>
        topHoldingItem(e, output.underperformers.length + output.candidates.length + i + 1),
      ),
    ];

    await prisma.$transaction([
      prisma.agentRun.update({
        where: { id: run.id },
        data: { status: "COMPLETE", completedAt: new Date(), output: output as unknown as object },
      }),
      ...draftItems.map((item) =>
        prisma.actionItem.create({
          data: {
            agentRunId: run.id,
            priority: item.priority,
            action: item.action,
            rationale: item.rationale,
            expectedImpact: item.expectedImpact,
            accountId: item.accountId,
          },
        }),
      ),
    ]);

    return { runId: run.id, status: "COMPLETE", output };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "FAILED", completedAt: new Date(), errorMessage: message },
    });
    return { runId: run.id, status: "FAILED", error: message };
  }
}

/**
 * Fire-and-forget trigger for the import pipeline — logs failures instead of
 * throwing, since an agent-scoring failure should never surface as an import
 * error to the user.
 */
export function triggerRelativeStrengthRun(): void {
  runAndPersistRelativeStrength().catch((err) => {
    console.error("Relative Strength agent auto-trigger failed:", err);
  });
}
