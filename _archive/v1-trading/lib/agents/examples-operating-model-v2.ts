/**
 * Agent Performance Operating Model v2 — Example Implementations
 *
 * This file demonstrates:
 *   1. Agent KPI computation and scoring
 *   2. Trading KPI aggregation
 *   3. Priority engine task ranking
 *   4. Execution agent incident detection
 *   5. Work freeze enforcement
 *   6. Morning brief generation
 *
 * Run these examples to validate the system behavior.
 */

import type { AgentKpiSummary } from "@/lib/agents/kpis";
import {
  calculateAgentScore,
  classifyAgentPerformance,
  computeAgentKpiSummary,
  identifyKpiCriticals,
  summarizeAgentKpiHealth,
} from "@/lib/agents/kpis";

import type { SharedTradingKpis } from "@/lib/agents/trading-kpis";
import { calculateFreezeConditions, detectKpiViolations } from "@/lib/agents/trading-kpis";

import { rankTasks, scoreTask } from "@/lib/agents/priority-engine";
import type { PriorityScore } from "@/lib/agents/priority-engine";

import { computeExecutionKpis, detectExecutionIncidents, summarizeExecutionHealth } from "@/lib/agents/execution-agent";
import type { ExecutionAgentBrief } from "@/lib/agents/execution-agent";

// ─── EXAMPLE 1: Agent KPI Calculation ──────────────────────────────────────

export function demonstrateAgentKpiCalculation() {
  console.log("\n📊 EXAMPLE 1: Agent KPI Calculation");
  console.log("═══════════════════════════════════════════════════════════════");

  // Simulated metrics
  const trainingMetrics = {
    avgR: 0.35,
    winRate: 0.62,
    executionRate: 0.68,
    latencySec: 145,
    staleSignalPct: 18,
    seededToExecutedPct: 67,
  };

  const functionalMetrics = {
    taskCompletionRate: 0.85,
    incidentResponseTime: 3, // minutes
    regressionsDetected: 0,
  };

  // Compute KPI summary for "execution" agent
  const kpis = computeAgentKpiSummary(
    "execution",
    trainingMetrics,
    functionalMetrics,
  );

  console.log(`\nAgent: ${kpis.agentName}`);
  console.log(`  Functional Score: ${kpis.functionalScore.toFixed(1)}/10`);
  console.log(`  Trading Score: ${kpis.tradingScore.toFixed(1)}/10`);
  console.log(`  Penalty Score: ${kpis.penaltyScore.toFixed(1)}/10`);
  console.log(`  ─────────────────────`);
  console.log(`  Total Score: ${kpis.totalScore.toFixed(1)}/10`);
  console.log(`  Classification: ${classifyAgentPerformance(kpis.totalScore)}`);

  console.log(`\nMetrics:`);
  console.log(`  Avg R: ${kpis.avgR?.toFixed(2)}`);
  console.log(`  Win Rate: ${(kpis.winRate! * 100).toFixed(0)}%`);
  console.log(`  Execution Rate: ${(kpis.executionRate! * 100).toFixed(0)}%`);
  console.log(`  Latency: ${kpis.latencySec}s`);
  console.log(`  Stale Signals: ${kpis.staleSignalPct}%`);

  const criticals = identifyKpiCriticals(kpis);
  if (criticals.length > 0) {
    console.log(`\n🔴 CRITICALS:`);
    criticals.forEach((c) => console.log(`  - ${c}`));
  }

  return kpis;
}

// ─── EXAMPLE 2: Multiple Agent KPI Health ─────────────────────────────────

export function demonstrateAgentKpiHealthSummary() {
  console.log("\n🏥 EXAMPLE 2: Multi-Agent KPI Health Summary");
  console.log("═══════════════════════════════════════════════════════════════");

  // Simulate 3 agents with different performance
  const agents: AgentKpiSummary[] = [
    {
      functionalScore: 8,
      tradingScore: 7,
      penaltyScore: 1,
      totalScore: 7.65,
      agentName: "execution",
      avgR: 0.35,
      winRate: 0.62,
      executionRate: 0.68,
      latencySec: 145,
    },
    {
      functionalScore: 7,
      tradingScore: 5,
      penaltyScore: 3,
      totalScore: 5.8,
      agentName: "risk",
      avgR: -0.1,
      winRate: 0.55,
      executionRate: 0.52,
      latencySec: 250,
    },
    {
      functionalScore: 6,
      tradingScore: 4,
      penaltyScore: 5,
      totalScore: 4.1,
      agentName: "performance",
      avgR: -0.3,
      winRate: 0.48,
      executionRate: 0.35,
      latencySec: 320,
    },
  ];

  const health = summarizeAgentKpiHealth(agents);

  console.log(`\nSystem Health:`);
  console.log(`  Overall Score: ${health.overallScore.toFixed(1)}/10`);
  console.log(`  Avg Trading Score: ${health.avgTradingScore.toFixed(1)}/10`);
  console.log(`  Avg Functional Score: ${health.avgFunctionalScore.toFixed(1)}/10`);

  console.log(`\nAgent Ranking:`);
  for (const agent of health.agentsByPerformance) {
    console.log(`  ${agent.agentName}: ${agent.status} (${agent.score.toFixed(1)})`);
  }
}

// ─── EXAMPLE 3: Trading KPI Aggregation & Freeze Detection ────────────────

export function demonstrateTradingKpiAggregation() {
  console.log("\n📈 EXAMPLE 3: Trading KPI Aggregation & Work Freeze");
  console.log("═══════════════════════════════════════════════════════════════");

  // Simulated healthy scenario
  const healthyKpis: SharedTradingKpis = {
    asOf: new Date().toISOString(),
    window: "24h",
    avgRealizedR: 0.42,
    winRate: 0.62,
    lossRate: 0.38,
    profitFactor: 1.85,
    seededToExecutedPct: 68,
    qualifiedToExecutedPct: 71,
    qualifiedToSeededPct: 95,
    signalToQualifiedPct: 75,
    executionRate: 0.68,
    executionLatencySec: 85,
    staleSignalPct: 12,
    freshSignalPct: 88,
    totalSeeds: 245,
    duplicateSeedRate: 0.01,
    drawdown: -1.2,
    protectionIntegrity: 0.98,
    brokerErrorRate: 0.02,
    scoringSuccessRate: 0.85,
    positionMismatchCount: 0,
    autoEntryEnabled: true,
    expectedRImpactPending: 0.5,
    actualRImpactRecent: 0.3,
    isCritical: false,
    freezeReasons: [],
  };

  // Simulated degraded scenario
  const degradedKpis: SharedTradingKpis = {
    ...healthyKpis,
    avgRealizedR: -0.3,
    seededToExecutedPct: 22,
    freshSignalPct: 35,
    executionLatencySec: 420,
    staleSignalPct: 65,
    isCritical: true,
  };

  console.log(`\n✅ HEALTHY SCENARIO:`);
  console.log(`  Avg R: ${healthyKpis.avgRealizedR.toFixed(2)}`);
  console.log(`  Execution: ${healthyKpis.seededToExecutedPct.toFixed(0)}%`);
  console.log(`  Fresh Signals: ${healthyKpis.freshSignalPct.toFixed(0)}%`);
  console.log(`  Latency: ${healthyKpis.executionLatencySec.toFixed(0)}s`);

  const healthyFreeze = calculateFreezeConditions(healthyKpis);
  console.log(`  Work Freeze: ${healthyFreeze.shouldFreeze ? "ACTIVE" : "INACTIVE"}`);
  console.log(`  Allowed Work: ${healthyFreeze.allowedWorkTypes.join(", ")}`);

  console.log(`\n🔴 DEGRADED SCENARIO:`);
  console.log(`  Avg R: ${degradedKpis.avgRealizedR.toFixed(2)}`);
  console.log(`  Execution: ${degradedKpis.seededToExecutedPct.toFixed(0)}%`);
  console.log(`  Fresh Signals: ${degradedKpis.freshSignalPct.toFixed(0)}%`);
  console.log(`  Latency: ${degradedKpis.executionLatencySec.toFixed(0)}s`);

  const degradedFreeze = calculateFreezeConditions(degradedKpis);
  console.log(`  Work Freeze: ${degradedFreeze.shouldFreeze ? "ACTIVE" : "INACTIVE"}`);
  if (degradedFreeze.shouldFreeze) {
    console.log(`  Freeze Reasons:`);
    degradedFreeze.reasons.forEach((r) => console.log(`    - ${r}`));
    console.log(`  Allowed Work: ${degradedFreeze.allowedWorkTypes.join(", ")}`);
  }

  console.log(`\nKPI Violations in degraded scenario:`);
  const violations = detectKpiViolations(degradedKpis);
  violations.forEach((v) => console.log(`  🔴 ${v}`));
}

// ─── EXAMPLE 4: Priority Engine Task Ranking ───────────────────────────────

export function demonstratePriorityEngineRanking() {
  console.log("\n⚡ EXAMPLE 4: Priority Engine Task Ranking");
  console.log("═══════════════════════════════════════════════════════════════");

  const degradedKpis: SharedTradingKpis = {
    asOf: new Date().toISOString(),
    window: "24h",
    avgRealizedR: -0.3,
    winRate: 0.45,
    lossRate: 0.55,
    profitFactor: 0.8,
    seededToExecutedPct: 22,
    qualifiedToExecutedPct: 25,
    qualifiedToSeededPct: 88,
    signalToQualifiedPct: 40,
    executionRate: 0.22,
    executionLatencySec: 420,
    staleSignalPct: 65,
    freshSignalPct: 35,
    totalSeeds: 100,
    duplicateSeedRate: 0.08,
    drawdown: -4.5,
    protectionIntegrity: 0.82,
    brokerErrorRate: 0.12,
    scoringSuccessRate: 0.60,
    positionMismatchCount: 8,
    autoEntryEnabled: true,
    expectedRImpactPending: 0,
    actualRImpactRecent: -0.4,
    isCritical: true,
    freezeReasons: [
      "Execution rate critical: 22% < 40%",
      "Fresh signal rate critical: 35% < 50%",
      "Execution latency critical: 420s > 300s",
    ],
  };

  // Sample tasks
  const tasks = [
    {
      id: "task-1",
      title: "CRITICAL: Execution latency bottleneck in seed-to-order flow",
      summary: "Reduce 420s latency to < 60s by optimizing broker order submission",
    },
    {
      id: "task-2",
      title: "Fix stale signal reseeding pipeline",
      summary: "Reseed signals older than 10min to maintain freshness",
    },
    {
      id: "task-3",
      title: "Implement UI theme dark mode support",
      summary: "Add dark mode toggle to improve UX",
    },
    {
      id: "task-4",
      title: "Remove duplicate seed requests from backlog",
      summary: "Deduplicate seeded orders to improve conversion",
    },
    {
      id: "task-5",
      title: "Refactor API response serialization",
      summary: "Improve API code organization",
    },
  ];

  console.log(`\nFUNNEL STATE: CRITICAL (work freeze active) 🔴`);
  console.log(`  Scoring ${tasks.length} tasks...`);

  const scored = tasks.map((t) => scoreTask(t, degradedKpis));

  console.log(`\nTASK RANKINGS (by trading impact):`);
  scored
    .sort((a, b) => b.score - a.score)
    .forEach((s, i) => {
      console.log(`  ${i + 1}. [${s.score.toFixed(0)}pts] ${s.title.substring(0, 60)}`);
      console.log(
        `     Category: ${s.category} | Severity: ${s.severity}/10 | Impact: ${s.tradingImpact}/10`,
      );
      if (s.frozen) {
        console.log(`     ⛔ FROZEN: ${s.freezeReason}`);
      }
    });

  console.log(`\n✅ EXECUTABLE TASKS (non-frozen during freeze):`);
  scored
    .filter((t) => !t.frozen)
    .slice(0, 3)
    .forEach((s) => {
      console.log(`  - ${s.title.substring(0, 70)}`);
    });
}

// ─── EXAMPLE 5: Execution Agent Incident Detection ────────────────────────

export function demonstrateExecutionAgentIncidents() {
  console.log("\n🚨 EXAMPLE 5: Execution Agent Incident Detection");
  console.log("═══════════════════════════════════════════════════════════════");

  const degradedKpis: SharedTradingKpis = {
    asOf: new Date().toISOString(),
    window: "24h",
    avgRealizedR: -0.3,
    winRate: 0.4,
    lossRate: 0.6,
    profitFactor: 0.65,
    seededToExecutedPct: 15,
    qualifiedToExecutedPct: 18,
    qualifiedToSeededPct: 83,
    signalToQualifiedPct: 25,
    executionRate: 0.15,
    executionLatencySec: 520,
    staleSignalPct: 72,
    freshSignalPct: 28,
    totalSeeds: 80,
    duplicateSeedRate: 0.12,
    drawdown: -5.8,
    protectionIntegrity: 0.71,
    brokerErrorRate: 0.15,
    scoringSuccessRate: 0.5,
    positionMismatchCount: 12,
    autoEntryEnabled: true,
    expectedRImpactPending: 0,
    actualRImpactRecent: -0.6,
    isCritical: true,
    freezeReasons: ["Critical execution funnel degradation"],
  };

  const incidents = detectExecutionIncidents(degradedKpis);

  console.log(`\nDetected ${incidents.length} execution incidents:`);
  incidents.forEach((incident) => {
    console.log(`\n  🔴 ${incident.title}`);
    console.log(`     Category: ${incident.category}`);
    console.log(`     Severity: ${incident.severity}`);
    console.log(`     Metric: ${incident.metric} = ${incident.currentValue.toFixed(2)}`);
    console.log(`     Threshold: ${incident.threshold.toFixed(2)}`);
  });

  // Compute execution agent KPIs
  const exKpis = computeExecutionKpis(degradedKpis);
  console.log(`\nExecution Agent KPIs:`);
  console.log(`  Functional: ${exKpis.functionalScore.toFixed(1)}/10`);
  console.log(`  Trading: ${exKpis.tradingScore.toFixed(1)}/10`);
  console.log(`  Penalty: ${exKpis.penaltyScore.toFixed(1)}/10`);
  console.log(`  Total: ${exKpis.totalScore.toFixed(1)}/10 (${classifyAgentPerformance(exKpis.totalScore)})`);
}

// ─── EXAMPLE 6: Morning Brief Generation ──────────────────────────────────

export function demonstrateMorningBrief() {
  console.log("\n🌅 EXAMPLE 6: Morning Brief — Performance-First Model");
  console.log("═══════════════════════════════════════════════════════════════");

  const briefDate = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  console.log(`\nCECIL TRADING APP — MORNING BRIEF`);
  console.log(`${briefDate}`);
  console.log();

  console.log(`🎯 PRIMARY OBJECTIVE: Trading Performance Optimization`);
  console.log();

  console.log(`📊 LAST 24H PERFORMANCE:`);
  console.log(`  Avg Realized R: 0.35 (↑ +0.15 vs prev day)`);
  console.log(`  Win Rate: 62% (↑ +3%)`);
  console.log(`  Execution Rate: 68% (↑ +8%)`);
  console.log(`  Fresh Signals: 88% (↑ +15%)`);
  console.log(`  Latency: 85s (↓ -45s)`);
  console.log();

  console.log(`⚠️  CRITICAL AREAS OF FOCUS:`);
  console.log(`  1. Maintained execution optimization`);
  console.log(`  2. Sustained signal freshness`);
  console.log(`  3. Drawdown protection (current: -1.2R)`);
  console.log();

  console.log(`💡 HIGHEST ROI FIXES TODAY:`);
  console.log(`  1. Refinement: Stop loss placement`);
  console.log(`     Est. Impact: Save 0.3-0.8R/day (prevent deep losses)`);
  console.log();
  console.log(`  2. Optimization: Intraday signal decay`);
  console.log(`     Est. Impact: +0.2 to +0.5R/day (improve entry timing)`);
  console.log();
  console.log(`  3. Enhancement: Multi-leg risk offsetting`);
  console.log(`     Est. Impact: Cost reduction only (volatility hedge)`);
  console.log();

  console.log(`🔧 ACTIVE ENGINEERING TASKS:`);
  console.log(`  ✅ CRITICAL: Execution latency (completed)`);
  console.log(`  ✅ HIGH: Stale signal elimination (in progress)`);
  console.log(`  ⏳ MEDIUM: Broker API optimization (queued)`);
  console.log();

  console.log(`🚀 AGENT PERFORMANCE:`);
  console.log(`  Execution Agent: GOOD (7.6/10)`);
  console.log(`  Risk Agent: ACCEPTABLE (5.8/10)`);
  console.log(`  Performance Agent: NEEDS_ATTENTION (4.1/10)`);
  console.log();

  console.log(`✅ PERMISSIONS: All work types permitted (no freeze)`);
  console.log();

  console.log(`Generated: ${new Date().toISOString()}`);
}

// ─── Main Demo Runner ──────────────────────────────────────────────────────

export function runAllExamples() {
  console.log("\n");
  console.log("╔═══════════════════════════════════════════════════════════════╗");
  console.log("║  Agent Performance Operating Model v2 — Example Demonstrations║");
  console.log("╚═══════════════════════════════════════════════════════════════╝");

  demonstrateAgentKpiCalculation();
  demonstrateAgentKpiHealthSummary();
  demonstrateTradingKpiAggregation();
  demonstratePriorityEngineRanking();
  demonstrateExecutionAgentIncidents();
  demonstrateMorningBrief();

  console.log("\n✅ All examples complete!\n");
}

// Run automatically if this is executed directly
if (typeof global !== "undefined" && global) {
  // Avoid running in test environments
  if (process.env.NODE_ENV !== "test") {
    // runAllExamples();
  }
}
