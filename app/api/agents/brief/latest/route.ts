export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { checkAgentReadAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import { listAgentBriefs, listOpenIncidents } from "@/lib/agents/store";
import { buildPriorityFeed } from "@/lib/agents/opportunity-engine";
import { getSharedTradingKpis } from "@/lib/agents/trading-kpis";
import { readExecutionBrief } from "@/lib/agents/execution-agent";

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function buildFallbackAgentKpis(kpis: any, executionBrief: any) {
  const execution = executionBrief ?? {};
  const healthBase = (v: number) => Math.max(0, Math.min(10, v));
  const expectedRImpact = toNumber(kpis?.expectedRImpactPending, 0);
  const actualRImpact = toNumber(kpis?.actualRImpactRecent, 0);
  return {
    "engineering-manager": {
      avgR: toNumber(kpis?.avgRealizedR, 0),
      realizedR: toNumber(kpis?.actualRImpactRecent, 0),
      expectedRImpact,
      actualRImpact,
      healthScore: healthBase(5 + toNumber(kpis?.avgRealizedR, 0) * 2),
    },
    engineering: {
      expectedRImpact,
      actualRImpact,
      buildSuccessRate: null,
      healthScore: healthBase(6),
    },
    execution: {
      seededToExecutedPct: toNumber(kpis?.seededToExecutedPct, 0),
      latencySec: toNumber(kpis?.executionLatencySec, 0),
      freshSignalPct: toNumber(kpis?.freshSignalPct, 0),
      staleSignalPct: toNumber(kpis?.staleSignalPct, 0),
      expectedRImpact,
      actualRImpact,
      healthScore: healthBase(toNumber(execution?.kpis?.totalScore, 5)),
    },
    risk: {
      maxLossR: Math.abs(toNumber(kpis?.drawdown, 0)),
      protectionIntegrity: toNumber(kpis?.protectionIntegrity, 1),
      drawdown: toNumber(kpis?.drawdown, 0),
      expectedRImpact,
      actualRImpact,
      healthScore: healthBase(10 * toNumber(kpis?.protectionIntegrity, 1)),
    },
    performance: {
      avgR: toNumber(kpis?.avgRealizedR, 0),
      winRate: toNumber(kpis?.winRate, 0),
      expectancy: toNumber(kpis?.avgRealizedR, 0),
      expectedRImpact,
      actualRImpact,
      healthScore: healthBase(5 + toNumber(kpis?.avgRealizedR, 0) * 2.5),
    },
    ops: {
      readiness: true,
      scannerHealth: "unknown",
      scoringHealth: "unknown",
      estimatedRLostToOutages: 0,
      healthScore: healthBase(7),
    },
    pm: {
      backlogRImpact: expectedRImpact,
      criticalBacklogCount: 0,
      healthScore: healthBase(6),
    },
  };
}

function hasUsableStoredBrief(brief: any): boolean {
  if (!brief || typeof brief !== "object") return false;
  const summary = typeof brief.summary === "string" ? brief.summary.trim() : "";
  return summary.length > 0;
}

export async function GET(req: Request) {
  const auth = await checkAgentReadAuth(req);
  if (!auth.ok) {
    return unauthorizedAgentResponse(auth.error);
  }

  const [briefs, incidents, priorityFeed, tradingKpis, executionBrief] = await Promise.all([
    listAgentBriefs(1),
    listOpenIncidents(20).catch(() => []),
    buildPriorityFeed(5).catch(() => ({ priorities: [] })),
    getSharedTradingKpis().catch(() => null),
    readExecutionBrief().catch(() => null),
  ]);

  const storedBrief = briefs[0] ?? null;
  if (hasUsableStoredBrief(storedBrief)) {
    const details = (storedBrief.details && typeof storedBrief.details === "object")
      ? storedBrief.details
      : {};
    const highestRoiFixes = Array.isArray((details as any).highestRoiFixes) ? (details as any).highestRoiFixes : [];
    const agentKpis = ((details as any).agentKpis && typeof (details as any).agentKpis === "object")
      ? (details as any).agentKpis
      : buildFallbackAgentKpis(tradingKpis, executionBrief);
    const topOpportunities = Array.isArray((details as any).topOpportunities) ? (details as any).topOpportunities : [];
    const summary = typeof storedBrief.summary === "string" && storedBrief.summary.trim().length > 0
      ? storedBrief.summary
      : "System is operational. No open incidents, but performance opportunities remain.";

    const brief = {
      executiveSummary: typeof (details as any).executiveSummary === "string" && (details as any).executiveSummary.trim().length > 0
        ? (details as any).executiveSummary
        : summary,
      topRisks: Array.isArray((details as any).topRisks) ? (details as any).topRisks : [],
      performanceBlockers: Array.isArray((details as any).performanceBlockers) ? (details as any).performanceBlockers : [],
      highestRoiFixes,
      agentKpis,
      tradingPerformance: ((details as any).tradingPerformance && typeof (details as any).tradingPerformance === "object")
        ? (details as any).tradingPerformance
        : {},
      funnelHealth: ((details as any).funnelHealth && typeof (details as any).funnelHealth === "object")
        ? (details as any).funnelHealth
        : {},
      topOpportunities,
      recommendedNextActions: Array.isArray((details as any).recommendedNextActions) ? (details as any).recommendedNextActions : [],
    };

    return NextResponse.json({
      ok: true,
      generatedAt: storedBrief.createdAt ?? new Date().toISOString(),
      summary,
      highestRoiFixes,
      agentKpis,
      topOpportunities,
      brief,
    });
  }

  const generatedAt = new Date().toISOString();
  const opportunities = priorityFeed.priorities ?? [];
  const topRisks = (incidents || []).slice(0, 5).map((i) => ({
    title: i.title,
    severity: i.severity,
    category: i.category,
    summary: i.summary,
  }));
  const performanceBlockers = opportunities
    .filter((o) => o.priority === "CRITICAL" || o.category === "P0_TRADING_BLOCKERS")
    .slice(0, 5);
  const highestRoiFixes = opportunities.slice(0, 3).map((o) => ({
    title: o.title,
    expectedRImpact: o.expectedRImpact,
    estimatedImpactText: o.estimatedImpactText,
    owner: o.owner,
    rationale: o.rationale,
  }));

  const summary =
    topRisks.length === 0
      ? "System is operational. No open incidents, but performance opportunities remain."
      : `System has ${topRisks.length} open risk(s); prioritize execution and funnel performance improvements.`;

  const agentKpis = buildFallbackAgentKpis(tradingKpis, executionBrief);

  return NextResponse.json({
    ok: true,
    generatedAt,
    summary,
    highestRoiFixes,
    agentKpis,
    topOpportunities: opportunities.slice(0, 5),
    brief: {
      executiveSummary: summary,
      topRisks,
      performanceBlockers,
      highestRoiFixes,
      agentKpis,
      tradingPerformance: {
        avgR: toNumber(tradingKpis?.avgRealizedR, 0),
        winRate: toNumber(tradingKpis?.winRate, 0),
        executionRate: toNumber(tradingKpis?.executionRate, 0),
        drawdown: toNumber(tradingKpis?.drawdown, 0),
      },
      funnelHealth: {
        seededToExecutedPct: toNumber(tradingKpis?.seededToExecutedPct, 0),
        qualifiedToExecutedPct: toNumber(tradingKpis?.qualifiedToExecutedPct, 0),
        freshSignalPct: toNumber(tradingKpis?.freshSignalPct, 0),
        staleSignalPct: toNumber(tradingKpis?.staleSignalPct, 0),
        latencySec: toNumber(tradingKpis?.executionLatencySec, 0),
      },
      topOpportunities: opportunities.slice(0, 5),
      recommendedNextActions: opportunities.slice(0, 5).map((o) => `${o.owner}: ${o.title}`),
    },
  });
}