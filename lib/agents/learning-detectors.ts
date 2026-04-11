/**
 * Learning Self-Heal Detectors — Phase 5
 *
 * Inspects recent trade performance AND signal/scoring health to emit
 * normalized remediation candidates. Builds on existing performanceLearning
 * for trade data and reads funnel counters for signal health.
 *
 * Each finding is a structured, machine-consumable record with:
 *   - id, category, severity, evidence, suggestedAction, metadata
 */

import { readPerformanceLearning } from "@/lib/agents/performanceLearning";
import { readTodayFunnel } from "@/lib/funnelRedis";
import { readSignals } from "@/lib/jsonDb";
import { getEtDateString } from "@/lib/time/etDate";
import type { PerformanceLearningSignals } from "@/lib/agents/types";

// ─── Types ──────────────────────────────────────────────────────────

export type FindingCategory =
  | "trade_performance"
  | "signal_health"
  | "scoring_health"
  | "qualification";

export type FindingSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface LearningFinding {
  id: string;
  category: FindingCategory;
  severity: FindingSeverity;
  evidence: string;
  suggestedAction: string;
  suggestedValue?: number | string | null;
  metadata?: Record<string, unknown>;
}

// ─── Signal/Scoring Health Helpers ──────────────────────────────────

interface SignalHealthSnapshot {
  todayEt: string;
  scansRun: number;
  signalsPosted: number;
  signalsReceived: number;
  gptScored: number;
  drainScored: number;
  drainError: number;
  drainPreGptSkipped: number;
  qualified: number;
  totalSignalsInStore: number;
  scoredInStore: number;
  pendingInStore: number;
  zeroScoreCount: number;
  lastScanAt: string | null;
  lastScanStatus: string | null;
}

async function buildSignalHealthSnapshot(): Promise<SignalHealthSnapshot> {
  const todayEt = getEtDateString();

  const [funnel, allSignals] = await Promise.all([
    readTodayFunnel().catch(() => null),
    readSignals().catch(() => []),
  ]);

  const todaySignals = allSignals.filter((s: any) => {
    const ts = s?.createdAt;
    if (!ts) return false;
    const d = Date.parse(ts);
    return Number.isFinite(d) && getEtDateString(new Date(d)) === todayEt;
  });

  const scored = todaySignals.filter(
    (s: any) => String(s?.status || "").toUpperCase() === "SCORED",
  );
  const pending = todaySignals.filter(
    (s: any) => String(s?.status || "").toUpperCase() === "PENDING",
  );
  const zeroScore = scored.filter(
    (s: any) => typeof s?.aiScore === "number" && s.aiScore === 0,
  );

  return {
    todayEt,
    scansRun: funnel?.scansRun ?? 0,
    signalsPosted: funnel?.signalsPosted ?? 0,
    signalsReceived: funnel?.signalsReceived ?? 0,
    gptScored: funnel?.gptScored ?? 0,
    drainScored: funnel?.drainScored ?? 0,
    drainError: funnel?.drainError ?? 0,
    drainPreGptSkipped: funnel?.drainPreGptSkipped ?? 0,
    qualified: funnel?.qualified ?? 0,
    totalSignalsInStore: todaySignals.length,
    scoredInStore: scored.length,
    pendingInStore: pending.length,
    zeroScoreCount: zeroScore.length,
    lastScanAt: funnel?.lastScanAt ?? null,
    lastScanStatus: funnel?.lastScanStatus ?? null,
  };
}

// ─── Detector Functions ─────────────────────────────────────────────

function detectTradePerformanceFindings(
  signals: PerformanceLearningSignals,
): LearningFinding[] {
  const findings: LearningFinding[] = [];

  if (signals.totalTrades < 5) return findings;

  // 1. Deep loss rate high
  if (signals.deepLossRate > 0.15) {
    findings.push({
      id: "deepLossRateHigh",
      category: "trade_performance",
      severity: signals.deepLossRate > 0.25 ? "CRITICAL" : "HIGH",
      evidence: `Deep loss rate ${(signals.deepLossRate * 100).toFixed(1)}% (${signals.deepLossCount} trades) over ${signals.totalTrades} trades`,
      suggestedAction: "reduce_max_open_positions",
      suggestedValue: 2,
      metadata: { deepLossRate: signals.deepLossRate, deepLossCount: signals.deepLossCount },
    });
  }

  // 2. Avg R degrading
  if (signals.avgR < -0.2) {
    findings.push({
      id: "avgRDegrading",
      category: "trade_performance",
      severity: signals.avgR < -0.5 ? "HIGH" : "MEDIUM",
      evidence: `Average R ${signals.avgR.toFixed(2)} across ${signals.totalTrades} trades`,
      suggestedAction: "reduce_max_entries_per_day",
      suggestedValue: 3,
      metadata: { avgR: signals.avgR },
    });
  }

  // 3. Side asymmetry
  if (
    signals.longWinRate < signals.shortWinRate - 0.15 &&
    signals.totalTrades >= 8
  ) {
    findings.push({
      id: "sideAsymmetryLongWeak",
      category: "trade_performance",
      severity: "MEDIUM",
      evidence: `Long win rate ${(signals.longWinRate * 100).toFixed(0)}% vs short ${(signals.shortWinRate * 100).toFixed(0)}%`,
      suggestedAction: "suppress_long_side",
      metadata: { longWinRate: signals.longWinRate, shortWinRate: signals.shortWinRate },
    });
  }
  if (
    signals.shortWinRate < signals.longWinRate - 0.15 &&
    signals.totalTrades >= 8
  ) {
    findings.push({
      id: "sideAsymmetryShortWeak",
      category: "trade_performance",
      severity: "MEDIUM",
      evidence: `Short win rate ${(signals.shortWinRate * 100).toFixed(0)}% vs long ${(signals.longWinRate * 100).toFixed(0)}%`,
      suggestedAction: "suppress_short_side",
      metadata: { longWinRate: signals.longWinRate, shortWinRate: signals.shortWinRate },
    });
  }

  // 4. Qualification rate low (win rate proxy)
  if (signals.winRate < 0.35 && signals.totalTrades >= 10) {
    findings.push({
      id: "qualificationRateLow",
      category: "qualification",
      severity: "HIGH",
      evidence: `Win rate ${(signals.winRate * 100).toFixed(0)}% over ${signals.totalTrades} trades suggests qualification is too permissive`,
      suggestedAction: "raise_min_score_threshold",
      suggestedValue: 1.0,
      metadata: { winRate: signals.winRate },
    });
  }

  return findings;
}

function detectSignalHealthFindings(
  snap: SignalHealthSnapshot,
): LearningFinding[] {
  const findings: LearningFinding[] = [];

  // 5. Zero score rate high
  if (snap.scoredInStore > 0 && snap.zeroScoreCount / snap.scoredInStore > 0.3) {
    findings.push({
      id: "zeroScoreRateHigh",
      category: "scoring_health",
      severity: "HIGH",
      evidence: `${snap.zeroScoreCount}/${snap.scoredInStore} scored signals have aiScore=0 (${((snap.zeroScoreCount / snap.scoredInStore) * 100).toFixed(0)}%)`,
      suggestedAction: "enable_zero_score_fallback_guard",
      metadata: { zeroScoreCount: snap.zeroScoreCount, scoredInStore: snap.scoredInStore },
    });
  }

  // 6. Scoring backlog high
  if (snap.pendingInStore > 10 && snap.scoredInStore < snap.pendingInStore) {
    findings.push({
      id: "scoringBacklogHigh",
      category: "scoring_health",
      severity: "MEDIUM",
      evidence: `${snap.pendingInStore} pending vs ${snap.scoredInStore} scored signals — scoring is falling behind`,
      suggestedAction: "increase_drain_frequency",
      metadata: { pendingInStore: snap.pendingInStore, scoredInStore: snap.scoredInStore },
    });
  }

  // 7. Low signal throughput during market hours
  if (
    snap.scansRun > 0 &&
    snap.signalsPosted === 0 &&
    snap.lastScanStatus === "RUN"
  ) {
    findings.push({
      id: "lowSignalThroughputDuringMarket",
      category: "signal_health",
      severity: "MEDIUM",
      evidence: `${snap.scansRun} scans completed but 0 signals posted (lastScan=${snap.lastScanAt})`,
      suggestedAction: "review_scanner_filters",
      metadata: { scansRun: snap.scansRun, signalsPosted: snap.signalsPosted, lastScanAt: snap.lastScanAt },
    });
  }

  // 8. Store vs funnel mismatch (signal persistence issue)
  if (
    snap.signalsReceived > 0 &&
    snap.totalSignalsInStore === 0
  ) {
    findings.push({
      id: "signalStoreFunnelMismatch",
      category: "signal_health",
      severity: "HIGH",
      evidence: `Funnel shows ${snap.signalsReceived} signals received but store has 0 signals for today — possible persistence or date windowing issue`,
      suggestedAction: "investigate_signal_persistence",
      metadata: { signalsReceived: snap.signalsReceived, totalSignalsInStore: snap.totalSignalsInStore },
    });
  }

  // 9. Drain errors elevated
  if (snap.drainError > 3) {
    findings.push({
      id: "drainErrorsElevated",
      category: "scoring_health",
      severity: "MEDIUM",
      evidence: `${snap.drainError} drain errors today — AI scoring may be unreliable`,
      suggestedAction: "throttle_drain_concurrency",
      metadata: { drainError: snap.drainError },
    });
  }

  return findings;
}

// ─── Main Analysis Entrypoint ───────────────────────────────────────

export interface LearningAnalysisResult {
  findings: LearningFinding[];
  signalHealth: SignalHealthSnapshot;
  performanceSignals: PerformanceLearningSignals | null;
  analyzedAt: string;
}

export async function runLearningAnalysis(): Promise<LearningAnalysisResult> {
  const [perfSignals, signalHealth] = await Promise.all([
    readPerformanceLearning().catch(() => null),
    buildSignalHealthSnapshot(),
  ]);

  const findings: LearningFinding[] = [];

  if (perfSignals) {
    findings.push(...detectTradePerformanceFindings(perfSignals));
  }

  findings.push(...detectSignalHealthFindings(signalHealth));

  // Sort by severity
  const severityOrder: Record<FindingSeverity, number> = {
    CRITICAL: 0,
    HIGH: 1,
    MEDIUM: 2,
    LOW: 3,
  };
  findings.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  console.log(
    `[LEARNING-DETECTORS] Analysis complete: ${findings.length} findings (${findings.filter((f) => f.severity === "CRITICAL" || f.severity === "HIGH").length} high/critical)`,
  );

  return {
    findings,
    signalHealth,
    performanceSignals: perfSignals,
    analyzedAt: new Date().toISOString(),
  };
}
