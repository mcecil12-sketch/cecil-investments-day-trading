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

function kpiOrNull(kpis: any, key: string, fallback = 0): number | null {
  const status = kpis?.metricStatus?.[key];
  if (status === "unavailable") return null;
  const n = Number(kpis?.[key]);
  return Number.isFinite(n) ? n : fallback;
}

function buildFallbackAgentKpis(kpis: any, executionBrief: any) {
  const execution = executionBrief ?? {};
  const healthBase = (v: number) => Math.max(0, Math.min(10, v));
  const expectedRImpact = kpiOrNull(kpis, "expectedRImpactPending");
  const actualRImpact = kpiOrNull(kpis, "actualRImpactRecent");
  const avgR = kpiOrNull(kpis, "avgRealizedR");
  const winRate = kpiOrNull(kpis, "winRate");
  const seededToExecutedPct = kpiOrNull(kpis, "seededToExecutedPct");
  const qualifiedToSeededPct = kpiOrNull(kpis, "qualifiedToSeededPct");
  const signalToQualifiedPct = kpiOrNull(kpis, "signalToQualifiedPct");
  const executionLatencySec = kpiOrNull(kpis, "executionLatencySec");
  const freshSignalPct = kpiOrNull(kpis, "freshSignalPct");
  const staleSignalPct = kpiOrNull(kpis, "staleSignalPct");

  return {
    "engineering-manager": {
      avgR,
      realizedR: actualRImpact,
      expectedRImpact,
      actualRImpact,
      metricStatus: kpis?.metricStatus ?? {},
      metricNotes: kpis?.metricNotes ?? [],
      healthScore: healthBase(5 + (avgR ?? 0) * 2),
    },
    engineering: {
      expectedRImpact,
      actualRImpact,
      buildSuccessRate: null,
      healthScore: healthBase(6),
    },
    execution: {
      seededToExecutedPct,
      qualifiedToSeededPct,
      signalToQualifiedPct,
      executionLatencySec,
      latencySec: executionLatencySec,
      freshSignalPct,
      staleSignalPct,
      expectedRImpact,
      actualRImpact,
      metricStatus: kpis?.metricStatus ?? {},
      healthScore: healthBase(toNumber(execution?.kpis?.totalScore, 5)),
    },
    risk: {
      maxLossR: Math.abs(toNumber(kpis?.drawdown, 0)),
      protectionIntegrity: kpiOrNull(kpis, "protectionIntegrity", 1),
      drawdown: toNumber(kpis?.drawdown, 0),
      expectedRImpact,
      actualRImpact,
      healthScore: healthBase(10 * (kpiOrNull(kpis, "protectionIntegrity", 1) ?? 1)),
    },
    performance: {
      avgR,
      realizedR: actualRImpact,
      winRate,
      expectancy: avgR,
      expectedRImpact,
      actualRImpact,
      metricStatus: kpis?.metricStatus ?? {},
      metricNotes: kpis?.metricNotes ?? [],
      healthScore: healthBase(5 + (avgR ?? 0) * 2.5),
    },
    ops: {
      readiness: kpiOrNull(kpis, "brokerErrorRate", 0) == null ? null : (kpiOrNull(kpis, "brokerErrorRate", 0) ?? 0) <= 0.1,
      scannerHealth: toNumber(kpis?.positionMismatchCount, 0) > 0 ? "degraded" : "healthy",
      scoringHealth: (kpiOrNull(kpis, "scoringSuccessRate") ?? 0) >= 0.75 ? "healthy" : "degraded",
      estimatedRLostToOutages: kpiOrNull(kpis, "brokerErrorRate", 0) == null ? null : Number(((kpiOrNull(kpis, "brokerErrorRate", 0) ?? 0) * 2).toFixed(3)),
      healthScore: healthBase(7 - (kpiOrNull(kpis, "brokerErrorRate", 0) ?? 0) * 10),
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
    const storedAgentKpis = ((details as any).agentKpis && typeof (details as any).agentKpis === "object")
      ? (details as any).agentKpis
      : null;
    const computedAgentKpis = buildFallbackAgentKpis(tradingKpis, executionBrief);
    const agentKpis = storedAgentKpis && typeof storedAgentKpis === "object"
      ? { ...storedAgentKpis, ...computedAgentKpis }
      : computedAgentKpis;
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
        avgR: kpiOrNull(tradingKpis, "avgRealizedR"),
        realizedR: kpiOrNull(tradingKpis, "actualRImpactRecent"),
        winRate: kpiOrNull(tradingKpis, "winRate"),
        expectancy: kpiOrNull(tradingKpis, "avgRealizedR"),
        executionRate: kpiOrNull(tradingKpis, "executionRate"),
        drawdown: toNumber(tradingKpis?.drawdown, 0),
        metricStatus: tradingKpis?.metricStatus ?? {},
        metricNotes: tradingKpis?.metricNotes ?? [],
      },
      funnelHealth: {
        signalToQualifiedPct: kpiOrNull(tradingKpis, "signalToQualifiedPct"),
        qualifiedToSeededPct: kpiOrNull(tradingKpis, "qualifiedToSeededPct"),
        seededToExecutedPct: kpiOrNull(tradingKpis, "seededToExecutedPct"),
        qualifiedToExecutedPct: kpiOrNull(tradingKpis, "qualifiedToExecutedPct"),
        freshSignalPct: kpiOrNull(tradingKpis, "freshSignalPct"),
        staleSignalPct: kpiOrNull(tradingKpis, "staleSignalPct"),
        latencySec: kpiOrNull(tradingKpis, "executionLatencySec"),
        metricStatus: tradingKpis?.metricStatus ?? {},
      },
      topOpportunities: opportunities.slice(0, 5),
      recommendedNextActions: opportunities.slice(0, 5).map((o) => `${o.owner}: ${o.title}`),
    },
  });
}