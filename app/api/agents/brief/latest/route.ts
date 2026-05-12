export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { checkAgentReadAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import { listAgentActions, listAgentBriefs, listOpenIncidents } from "@/lib/agents/store";
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

function ensureArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function buildTradingPerformance(kpis: any): Record<string, unknown> {
  return {
    avgR: toNumber(kpis?.avgRealizedR, 0),
    realizedR: toNumber(kpis?.actualRImpactRecent, 0),
    winRate: toNumber(kpis?.winRate, 0),
    expectancy: toNumber(kpis?.avgRealizedR, 0),
    status: "derived_from_shared_kpis",
  };
}

function buildFunnelHealth(kpis: any): Record<string, unknown> {
  const qualified = toNumber(kpis?.totalSeeds, 0);
  const seeded = toNumber(kpis?.totalSeeds, 0);
  const executed = Math.round((seeded * toNumber(kpis?.qualifiedToExecutedPct, 0)) / 100);
  return {
    candidates: null,
    signals: qualified,
    scored: null,
    qualified,
    seeded,
    executed,
    conversion: toNumber(kpis?.qualifiedToExecutedPct, 0),
    latency: toNumber(kpis?.executionLatencySec, 0),
    seededToExecutedPct: toNumber(kpis?.seededToExecutedPct, 0),
    freshSignalPct: toNumber(kpis?.freshSignalPct, 0),
    staleSignalPct: toNumber(kpis?.staleSignalPct, 0),
    status: "derived_from_shared_kpis",
  };
}

function buildRecommendedNextActions(topOpportunities: Array<Record<string, unknown>>, recentActions: any[]): string[] {
  const fromOps = topOpportunities
    .slice(0, 3)
    .map((o) => `${String(o.owner ?? "engineering-manager")}: ${String(o.title ?? "Advance top optimization opportunity")}`);

  if (fromOps.length >= 3) return fromOps;

  const fromRecent = recentActions
    .slice(0, 3)
    .map((a) => `${String(a.agent ?? "ops")}: follow through on ${String(a.summary ?? "recent execution item")}`);

  return [...fromOps, ...fromRecent, "engineering-manager: review top priorities and schedule highest ROI fix"]
    .slice(0, 3);
}

export async function GET(req: Request) {
  const auth = await checkAgentReadAuth(req);
  if (!auth.ok) {
    return unauthorizedAgentResponse(auth.error);
  }

  const [briefs, incidents, priorityFeed, tradingKpis, executionBrief, recentActions] = await Promise.all([
    listAgentBriefs(1),
    listOpenIncidents(20).catch(() => []),
    buildPriorityFeed(5).catch(() => ({ priorities: [] })),
    getSharedTradingKpis().catch(() => null),
    readExecutionBrief().catch(() => null),
    listAgentActions(5).catch(() => []),
  ]);

  const opportunities = ensureArray<any>(priorityFeed.priorities);
  const topRisksFallback = (incidents || []).slice(0, 5).map((i) => ({
    title: i.title,
    severity: i.severity,
    category: i.category,
    summary: i.summary,
    status: i.status,
  }));
  const topOpportunitiesFallback = opportunities.slice(0, 5).map((o) => ({
    title: o.title,
    priority: o.priority,
    severity: o.priority,
    owner: o.owner,
    expectedRImpact: o.expectedRImpact,
    estimatedImpactText: o.estimatedImpactText,
    rationale: o.rationale,
    status: o.status,
  }));
  const highestRoiFixesFallback = topOpportunitiesFallback.slice(0, 3);
  const summaryFallback =
    topRisksFallback.length === 0
      ? "System is healthy and autonomous optimization is active. Focus on highest ROI execution and funnel improvements."
      : `System has ${topRisksFallback.length} active risk(s); prioritize stabilization while preserving optimization throughput.`;
  const executiveSummaryFallback = `Phase 6A autonomous operating layer is active. ${summaryFallback}`;
  const tradingPerformanceFallback = buildTradingPerformance(tradingKpis);
  const funnelHealthFallback = buildFunnelHealth(tradingKpis);
  const recommendedNextActionsFallback = buildRecommendedNextActions(topOpportunitiesFallback, recentActions);

  const storedBrief = briefs[0] ?? null;
  if (hasUsableStoredBrief(storedBrief)) {
    const details = safeObject(storedBrief.details);
    const highestRoiFixes = ensureArray<any>((details as any).highestRoiFixes).length > 0
      ? ensureArray<any>((details as any).highestRoiFixes)
      : highestRoiFixesFallback;
    const agentKpis = ((details as any).agentKpis && typeof (details as any).agentKpis === "object")
      ? (details as any).agentKpis
      : buildFallbackAgentKpis(tradingKpis, executionBrief);
    const topOpportunities = ensureArray<any>((details as any).topOpportunities).length > 0
      ? ensureArray<any>((details as any).topOpportunities)
      : topOpportunitiesFallback;
    const summary = typeof storedBrief.summary === "string" && storedBrief.summary.trim().length > 0
      ? storedBrief.summary
      : summaryFallback;

    const topRisks = ensureArray<any>((details as any).topRisks).length > 0
      ? ensureArray<any>((details as any).topRisks)
      : topRisksFallback;
    const performanceBlockers = ensureArray<any>((details as any).performanceBlockers).length > 0
      ? ensureArray<any>((details as any).performanceBlockers)
      : topOpportunities.filter((o: any) => o.priority === "CRITICAL" || o.priority === "HIGH").slice(0, 5);
    const executiveSummary = typeof (details as any).executiveSummary === "string" && String((details as any).executiveSummary).trim().length > 0
      ? String((details as any).executiveSummary)
      : executiveSummaryFallback;
    const tradingPerformance = ((details as any).tradingPerformance && typeof (details as any).tradingPerformance === "object")
      ? (details as any).tradingPerformance
      : tradingPerformanceFallback;
    const funnelHealth = ((details as any).funnelHealth && typeof (details as any).funnelHealth === "object")
      ? (details as any).funnelHealth
      : funnelHealthFallback;
    const recommendedNextActions = ensureArray<string>((details as any).recommendedNextActions).length > 0
      ? ensureArray<string>((details as any).recommendedNextActions)
      : recommendedNextActionsFallback;

    const brief = {
      generatedAt: storedBrief.createdAt ?? new Date().toISOString(),
      summary,
      executiveSummary,
      topRisks,
      performanceBlockers,
      highestRoiFixes,
      agentKpis,
      tradingPerformance,
      funnelHealth,
      topOpportunities,
      recommendedNextActions,
    };

    return NextResponse.json({
      ok: true,
      generatedAt: brief.generatedAt,
      summary,
      executiveSummary,
      topRisks,
      performanceBlockers,
      highestRoiFixes,
      agentKpis,
      tradingPerformance,
      funnelHealth,
      topOpportunities,
      recommendedNextActions,
      brief,
    });
  }

  const generatedAt = new Date().toISOString();
  const topRisks = topRisksFallback;
  const performanceBlockers = opportunities
    .filter((o) => o.priority === "CRITICAL" || o.category === "P0_TRADING_BLOCKERS")
    .slice(0, 5)
    .map((o) => ({
      title: o.title,
      priority: o.priority,
      owner: o.owner,
      rationale: o.rationale,
      status: o.status,
    }));
  const highestRoiFixes = highestRoiFixesFallback;

  const summary = summaryFallback;
  const executiveSummary = executiveSummaryFallback;

  const agentKpis = buildFallbackAgentKpis(tradingKpis, executionBrief);
  const topOpportunities = topOpportunitiesFallback;
  const recommendedNextActions = recommendedNextActionsFallback;
  const tradingPerformance = tradingPerformanceFallback;
  const funnelHealth = funnelHealthFallback;

  const brief = {
    generatedAt,
    summary,
    executiveSummary,
    topRisks,
    performanceBlockers,
    highestRoiFixes,
    agentKpis,
    tradingPerformance,
    funnelHealth,
    topOpportunities,
    recommendedNextActions,
  };

  return NextResponse.json({
    ok: true,
    generatedAt,
    summary,
    executiveSummary,
    topRisks,
    performanceBlockers,
    highestRoiFixes,
    agentKpis,
    tradingPerformance,
    funnelHealth,
    topOpportunities,
    recommendedNextActions,
    brief,
  });
}