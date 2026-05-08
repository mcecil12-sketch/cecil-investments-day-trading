/**
 * Trading Health Signals — Profit-First Agent Intelligence
 *
 * Evaluates core trading metrics and returns a list of actionable issues
 * that the agent trigger loop can convert into tasks.
 */

export type TradingIssueType =
  | "NEGATIVE_R"
  | "RISK_BREACH"
  | "LATENCY"
  | "STALE_SIGNALS"
  | "LOW_EXECUTION";

export type TradingIssueSeverity = "CRITICAL" | "HIGH";

export interface TradingIssue {
  type: TradingIssueType;
  severity: TradingIssueSeverity;
}

export interface TradingHealthMetrics {
  /** Average realized R across recent closed trades; null if no trades */
  avgR: number | null;
  /** Worst (most negative) realized R in recent trades; null if no trades */
  maxLossR: number | null;
  /** Milliseconds since last successful signal scoring or trade activity */
  latencyMs: number;
  /** Fraction of evaluated signals that are stale (0–1) */
  stalePct: number;
  /** Fraction of qualified signals that resulted in executed trades (0–1) */
  executionRate: number;
}

/**
 * Evaluate trading health metrics and return a list of detected issues.
 * Issues are ordered by severity: CRITICAL first, then HIGH.
 */
export function evaluateTradingHealth(metrics: TradingHealthMetrics): TradingIssue[] {
  const issues: TradingIssue[] = [];

  if (metrics.avgR !== null && metrics.avgR < 0) {
    issues.push({ type: "NEGATIVE_R", severity: "CRITICAL" });
  }

  if (metrics.maxLossR !== null && metrics.maxLossR < -2) {
    issues.push({ type: "RISK_BREACH", severity: "CRITICAL" });
  }

  if (metrics.latencyMs > 300000) {
    issues.push({ type: "LATENCY", severity: "CRITICAL" });
  }

  if (metrics.stalePct > 0.3) {
    issues.push({ type: "STALE_SIGNALS", severity: "CRITICAL" });
  }

  if (metrics.executionRate < 0.5) {
    issues.push({ type: "LOW_EXECUTION", severity: "HIGH" });
  }

  return issues;
}
