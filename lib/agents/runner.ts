import { prisma } from "@/lib/prisma";
import { Prisma } from "@/lib/generated/prisma";
import { runRelativeStrengthAgent, type RelativeStrengthEntry, type RelativeStrengthOutput } from "@/lib/agents/relativeStrength";
import { runSectorRotationAgent, type SectorScore, type SectorRotationFlag, type SectorRotationOutput } from "@/lib/agents/sectorRotation";
import { runRiskManagerAgent, type RiskFlag, type OpportunityCostEntry, type RiskManagerOutput } from "@/lib/agents/riskManager";
import { runCandidateScannerAgent, type CandidateEntry, type CandidateScannerOutput } from "@/lib/agents/candidateScanner";
import { refreshCandidateUniverse, type UniverseRefreshResult } from "@/lib/agents/candidateUniverse";
import { synthesizeCioBrief, type CioCandidateItem } from "@/lib/agents/cio";
import { buildTaxableAnalysisContext, type TaxableAnalysisContext } from "@/lib/agents/taxableAnalysis";
import { sendWeeklyBriefNotification } from "@/lib/notifications/weeklyBrief";

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

function withNote(rationale: string, entry: RelativeStrengthEntry): string {
  return entry.note ? `${rationale} (${entry.note}.)` : rationale;
}

function underperformerItem(entry: RelativeStrengthEntry, priority: number): DraftActionItem {
  return {
    priority,
    action: `Review ${entry.symbol} — trailing relative strength`,
    rationale: withNote(
      `Score ${entry.score}/100 (${formatPercent(entry.relativeScore / 100)} vs S&P 500), 52-week momentum ${formatPercent(entry.momentum)}.`,
      entry,
    ),
    expectedImpact: "Reduces drag from a persistently lagging position.",
    accountId: entry.accountIds.length === 1 ? entry.accountIds[0] : null,
  };
}

function candidateItem(entry: RelativeStrengthEntry, priority: number): DraftActionItem {
  return {
    priority,
    action: `Watch ${entry.symbol} — building relative strength`,
    rationale: withNote(
      `Score ${entry.score}/100, 52-week momentum ${formatPercent(entry.momentum)}, trading ${entry.aboveSma50 ? "above" : "below"} its 50-day average.`,
      entry,
    ),
    expectedImpact: "Early signal for a potential add if strength continues.",
    accountId: entry.accountIds.length === 1 ? entry.accountIds[0] : null,
  };
}

function topHoldingItem(entry: RelativeStrengthEntry, priority: number): DraftActionItem {
  return {
    priority,
    action: `Hold ${entry.symbol} — leading relative strength`,
    rationale: withNote(
      `Score ${entry.score}/100 (${formatPercent(entry.relativeScore / 100)} vs S&P 500), 52-week momentum ${formatPercent(entry.momentum)}.`,
      entry,
    ),
    expectedImpact: "Confirms the position is still earning its place in the portfolio.",
    accountId: entry.accountIds.length === 1 ? entry.accountIds[0] : null,
  };
}

export interface RelativeStrengthRunResult {
  runId: string;
  status: "COMPLETE" | "FAILED";
  output?: RelativeStrengthOutput;
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

function sectorFlagItem(flag: SectorRotationFlag, priority: number): DraftActionItem {
  return {
    priority,
    action:
      flag.type === "overweight_weakening"
        ? `Reduce ${flag.sector} exposure — weakening sector`
        : `Consider adding ${flag.sector} exposure — leading sector`,
    rationale: flag.detail,
    expectedImpact:
      flag.type === "overweight_weakening"
        ? "Cuts exposure to a sector losing relative strength."
        : "Captures a sector gaining relative strength.",
    accountId: null,
  };
}

function sectorRecommendationItem(sector: SectorScore, priority: number): DraftActionItem {
  return {
    priority,
    action: `Watch ${sector.sector} (${sector.symbol}) — leading sector rotation signal`,
    rationale: `Composite score ${sector.score}/100 (1M ${formatPercent(sector.oneMonth)}, 3M ${formatPercent(sector.threeMonth)}, 12M ${formatPercent(sector.twelveMonth)}).`,
    expectedImpact: "Early signal for a sector-level tilt.",
    accountId: null,
  };
}

export interface SectorRotationRunResult {
  runId: string;
  status: "COMPLETE" | "FAILED";
  output?: SectorRotationOutput;
  error?: string;
}

/** Runs the Sector Rotation agent and persists its AgentRun + derived ActionItems, same pattern as Relative Strength. */
export async function runAndPersistSectorRotation(): Promise<SectorRotationRunResult> {
  const run = await prisma.agentRun.create({
    data: { agentType: "SECTOR_ROTATION", status: "RUNNING" },
  });

  try {
    const output = await runSectorRotationAgent();

    const draftItems: DraftActionItem[] = [
      ...output.flags.map((f, i) => sectorFlagItem(f, i + 1)),
      ...output.topSectors.map((s, i) => sectorRecommendationItem(s, output.flags.length + i + 1)),
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

function riskFlagItem(flag: RiskFlag, priority: number): DraftActionItem {
  return {
    priority,
    action: flag.title,
    rationale: flag.detail,
    expectedImpact: flag.severity === "critical" ? "Address to reduce portfolio risk." : "Monitor for further deterioration.",
    accountId: flag.accountId,
  };
}

function opportunityCostItem(entry: OpportunityCostEntry, priority: number): DraftActionItem {
  return {
    priority,
    action: `Reallocate ${entry.symbol} — better option in plan menu`,
    rationale: entry.detail,
    expectedImpact: `Closing the gap to ${entry.alternativeName} could improve 5Y return by roughly ${formatPercent(entry.gap)}.`,
    accountId: null,
  };
}

export interface RiskManagerRunResult {
  runId: string;
  status: "COMPLETE" | "FAILED";
  output?: RiskManagerOutput;
  error?: string;
}

/**
 * Runs the Risk Manager agent and persists its AgentRun + derived
 * ActionItems. Informational flags aren't surfaced as action items — they're
 * awareness-only and have nothing to "do."
 */
export async function runAndPersistRiskManager(): Promise<RiskManagerRunResult> {
  const run = await prisma.agentRun.create({
    data: { agentType: "RISK_MANAGER", status: "RUNNING" },
  });

  try {
    const output = await runRiskManagerAgent();

    const draftItems: DraftActionItem[] = [
      ...output.critical.map((f, i) => riskFlagItem(f, i + 1)),
      ...output.watch.map((f, i) => riskFlagItem(f, output.critical.length + i + 1)),
      ...output.opportunityCost.map((o, i) => opportunityCostItem(o, output.critical.length + output.watch.length + i + 1)),
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

    try {
      await runAndPersistCandidateScanner();
      await synthesizeWeeklyBrief();
      const notificationResult = await sendWeeklyBriefNotification();
      if (!notificationResult.sent) {
        console.log("Weekly brief notification not sent:", notificationResult.reason);
      }
    } catch (err) {
      console.error("Candidate Scanner / CIO synthesis after Risk Manager run failed:", err);
    }

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

function candidateAddItem(entry: CandidateEntry, priority: number): DraftActionItem {
  return {
    priority,
    action: `ADD ${entry.symbol} — new candidate`,
    rationale: entry.rationale,
    expectedImpact: `New position in ${entry.sector}, scoring ${entry.vsSpx > 0 ? "+" : ""}${entry.vsSpx} vs S&P 500 (${entry.accountType === "taxable" ? "taxable only" : entry.accountType === "401k" ? "401k only" : "taxable or 401k"}).`,
    accountId: null,
  };
}

export interface CandidateScannerRunResult {
  runId: string;
  status: "COMPLETE" | "FAILED";
  output?: CandidateScannerOutput;
  error?: string;
}

/**
 * Runs the Candidate Scanner agent and persists its AgentRun + derived
 * ActionItems. Auto-triggered after every Risk Manager run (see
 * runAndPersistRiskManager above) so a fresh candidate list is always ready
 * before the CIO synthesis step reads it.
 */
export async function runAndPersistCandidateScanner(): Promise<CandidateScannerRunResult> {
  const run = await prisma.agentRun.create({
    data: { agentType: "CANDIDATE_SCANNER", status: "RUNNING" },
  });

  try {
    const output = await runCandidateScannerAgent();

    const draftItems: DraftActionItem[] = output.topCandidates.slice(0, 5).map((c, i) => candidateAddItem(c, i + 1));

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

export interface UniverseRefreshRunResult {
  runId: string;
  status: "COMPLETE" | "FAILED";
  output?: UniverseRefreshResult[];
  error?: string;
}

/**
 * Runs the monthly candidate-universe refresh (pulls fresh SPDR sector
 * holdings from SSGA for the dynamic sectors — see candidateUniverse.ts) and
 * persists an AgentRun audit trail, same lifecycle pattern as the analysis
 * agents above. No ActionItems: this is a data refresh, not a
 * recommendation.
 */
export async function runAndPersistCandidateUniverseRefresh(): Promise<UniverseRefreshRunResult> {
  const run = await prisma.agentRun.create({
    data: { agentType: "UNIVERSE_REFRESH", status: "RUNNING" },
  });

  try {
    const output = await refreshCandidateUniverse();
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { status: "COMPLETE", completedAt: new Date(), output: output as unknown as object },
    });
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

function startOfWeekUTC(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  const diff = (day === 0 ? -6 : 1) - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

/**
 * Builds this week's candidate item list from the latest completed run of
 * each agent, tagged with a stable key + source so the CIO synthesis step can
 * reference and reorder them without hallucinating new ones.
 */
async function buildCioCandidates(): Promise<{
  candidates: CioCandidateItem[];
  riskRun: { id: string } | null;
  relativeRun: { id: string } | null;
  sectorRun: { id: string } | null;
  candidateRun: { id: string } | null;
  taxableContext: TaxableAnalysisContext | null;
}> {
  const [riskRun, relativeRun, sectorRun, candidateRun] = await Promise.all([
    prisma.agentRun.findFirst({ where: { agentType: "RISK_MANAGER", status: "COMPLETE" }, orderBy: { startedAt: "desc" } }),
    prisma.agentRun.findFirst({ where: { agentType: "RELATIVE_STRENGTH", status: "COMPLETE" }, orderBy: { startedAt: "desc" } }),
    prisma.agentRun.findFirst({ where: { agentType: "SECTOR_ROTATION", status: "COMPLETE" }, orderBy: { startedAt: "desc" } }),
    prisma.agentRun.findFirst({ where: { agentType: "CANDIDATE_SCANNER", status: "COMPLETE" }, orderBy: { startedAt: "desc" } }),
  ]);

  const candidates: CioCandidateItem[] = [];

  if (riskRun?.output) {
    const output = riskRun.output as unknown as RiskManagerOutput;
    output.critical.slice(0, 5).forEach((flag, i) => {
      candidates.push({
        key: `risk-critical-${i}`,
        source: "risk_critical",
        agentRunId: riskRun.id,
        action: flag.title,
        rationale: flag.detail,
        expectedImpact: "Critical risk flag — act immediately.",
        accountId: flag.accountId,
      });
    });
    output.watch.slice(0, 5).forEach((flag, i) => {
      candidates.push({
        key: `risk-watch-${i}`,
        source: "risk_watch",
        agentRunId: riskRun.id,
        action: flag.title,
        rationale: flag.detail,
        expectedImpact: "Monitor for further deterioration.",
        accountId: flag.accountId,
      });
    });
    output.opportunityCost.slice(0, 3).forEach((entry, i) => {
      candidates.push({
        key: `opportunity-cost-${i}`,
        source: "opportunity_cost",
        agentRunId: riskRun.id,
        action: `Reallocate ${entry.symbol} — better option in plan menu`,
        rationale: entry.detail,
        expectedImpact: `Closing the gap to ${entry.alternativeName} could improve 5Y return by roughly ${formatPercent(entry.gap)}.`,
        accountId: null,
      });
    });
  }
  if (relativeRun?.output) {
    const output = relativeRun.output as unknown as RelativeStrengthOutput;
    output.topHoldings.slice(0, 3).forEach((entry, i) => {
      candidates.push({
        key: `rs-top-${i}`,
        source: "relative_strength_top",
        agentRunId: relativeRun.id,
        action: `Highest-conviction opportunity: ${entry.symbol}`,
        rationale: withNote(
          `Score ${entry.score}/100 (${formatPercent(entry.relativeScore / 100)} vs S&P 500), 52-week momentum ${formatPercent(entry.momentum)}.`,
          entry,
        ),
        expectedImpact: "Reinforces or adds to a position building relative strength.",
        accountId: entry.accountIds.length === 1 ? entry.accountIds[0] : null,
      });
    });
    output.candidates.slice(0, 3).forEach((entry, i) => {
      candidates.push({
        key: `rs-candidate-${i}`,
        source: "relative_strength_candidate",
        agentRunId: relativeRun.id,
        action: `Watch ${entry.symbol} — building relative strength`,
        rationale: withNote(
          `Score ${entry.score}/100, 52-week momentum ${formatPercent(entry.momentum)}.`,
          entry,
        ),
        expectedImpact: "Early signal for a potential add if strength continues.",
        accountId: entry.accountIds.length === 1 ? entry.accountIds[0] : null,
      });
    });
    output.underperformers.slice(0, 3).forEach((entry, i) => {
      candidates.push({
        key: `rs-underperformer-${i}`,
        source: "relative_strength_underperformer",
        agentRunId: relativeRun.id,
        action: `Review ${entry.symbol} — trailing relative strength`,
        rationale: withNote(
          `Score ${entry.score}/100 (${formatPercent(entry.relativeScore / 100)} vs S&P 500), 52-week momentum ${formatPercent(entry.momentum)}.`,
          entry,
        ),
        expectedImpact: "Reduces drag from a persistently lagging position.",
        accountId: entry.accountIds.length === 1 ? entry.accountIds[0] : null,
      });
    });
  }
  if (sectorRun?.output) {
    const output = sectorRun.output as unknown as SectorRotationOutput;
    output.flags.slice(0, 3).forEach((flag, i) => {
      candidates.push({
        key: `sector-flag-${i}`,
        source: "sector_flag",
        agentRunId: sectorRun.id,
        action:
          flag.type === "overweight_weakening"
            ? `Reduce ${flag.sector} exposure — weakening sector`
            : `Consider adding ${flag.sector} exposure — leading sector`,
        rationale: flag.detail,
        expectedImpact:
          flag.type === "overweight_weakening"
            ? "Cuts exposure to a sector losing relative strength."
            : "Captures a sector gaining relative strength.",
        accountId: null,
      });
    });
    output.topSectors.slice(0, 3).forEach((sector, i) => {
      candidates.push({
        key: `sector-top-${i}`,
        source: "sector_top",
        agentRunId: sectorRun.id,
        action: `Sector rotation signal: ${sector.sector}`,
        rationale: `Composite score ${sector.score}/100 (1M ${formatPercent(sector.oneMonth)}, 3M ${formatPercent(sector.threeMonth)}, 12M ${formatPercent(sector.twelveMonth)}).`,
        expectedImpact: "Early signal for a sector-level tilt.",
        accountId: null,
      });
    });
  }

  if (candidateRun?.output) {
    const output = candidateRun.output as unknown as CandidateScannerOutput;
    output.topCandidates.slice(0, 5).forEach((c, i) => {
      candidates.push({
        key: `candidate-add-${i}`,
        source: "candidate_new",
        agentRunId: candidateRun.id,
        action: `ADD ${c.symbol} — new candidate`,
        rationale: c.rationale,
        expectedImpact: `New position in ${c.sector}, scoring ${c.vsSpx > 0 ? "+" : ""}${c.vsSpx} vs S&P 500 (${c.accountType === "taxable" ? "taxable only" : c.accountType === "401k" ? "401k only" : "taxable or 401k"}).`,
        accountId: null,
      });
    });
  }

  const taxableContext = await buildTaxableAnalysisContext(
    sectorRun?.output ? (sectorRun.output as unknown as SectorRotationOutput) : null,
    relativeRun?.output ? (relativeRun.output as unknown as RelativeStrengthOutput) : null,
  );

  return { candidates, riskRun, relativeRun, sectorRun, candidateRun, taxableContext };
}

/**
 * Rebuilds the current week's WeeklyBrief by sending the latest completed
 * run of each agent to Claude for natural-language synthesis and priority
 * ranking (see lib/agents/cio.ts). Called after the post-import agent
 * sequence, and after every standalone Risk Manager run (which itself
 * triggers a fresh Candidate Scanner run first), so the CIO Weekly Action
 * List reflects all four agents instead of just whichever ran most recently.
 */
export async function synthesizeWeeklyBrief(): Promise<void> {
  const { candidates, taxableContext } = await buildCioCandidates();
  if (candidates.length === 0) return;

  const brief = await synthesizeCioBrief(candidates, taxableContext);
  if (brief.orderedItems.length === 0) return;

  const weekOf = startOfWeekUTC(new Date());
  const actionItemsData = brief.orderedItems.map((item, i) => ({
    agentRunId: item.agentRunId,
    action: item.action,
    rationale: item.rationale,
    expectedImpact: item.expectedImpact,
    accountId: item.accountId,
    priority: i + 1,
  }));
  const taxableOpportunities = (brief.taxableOpportunities ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue;

  const existing = await prisma.weeklyBrief.findUnique({ where: { weekOf } });
  if (existing) {
    await prisma.$transaction([
      prisma.actionItem.deleteMany({ where: { weeklyBriefId: existing.id } }),
      prisma.weeklyBrief.update({
        where: { id: existing.id },
        data: { cioSummary: brief.summary, taxableOpportunities, actionItems: { create: actionItemsData } },
      }),
    ]);
  } else {
    await prisma.weeklyBrief.create({
      data: { weekOf, cioSummary: brief.summary, taxableOpportunities, actionItems: { create: actionItemsData } },
    });
  }
}

/**
 * Fire-and-forget trigger for the import pipeline — runs the agent sequence
 * (Relative Strength → Sector Rotation → Risk Manager → Candidate Scanner).
 * Risk Manager's own persistence runs Candidate Scanner and resynthesizes the
 * CIO Weekly Action List once all four have fresh output. Logs failures
 * instead of throwing, since an agent-scoring failure should never surface
 * as an import error to the user.
 */
export function triggerAllAgentsRun(): void {
  (async () => {
    await runAndPersistRelativeStrength();
    await runAndPersistSectorRotation();
    await runAndPersistRiskManager();
  })().catch((err) => {
    console.error("Post-import agent sequence failed:", err);
  });
}
