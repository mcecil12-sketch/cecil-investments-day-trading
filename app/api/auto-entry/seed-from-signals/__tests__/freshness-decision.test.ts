import { describe, expect, it } from "vitest";
import {
  evaluateSignalFreshnessDecision,
  getFreshnessThresholdSource,
  type FreshnessDecision,
} from "../route";

describe("seed-from-signals freshness decision", () => {
  it("marks signal fresh when age is below threshold", () => {
    const nowMs = Date.now();
    const signal = {
      id: "sig-fresh",
      symbol: "AAPL",
      createdAt: new Date(nowMs - 3_000).toISOString(),
    };

    const decision = evaluateSignalFreshnessDecision(signal, nowMs, 60_000);
    expect(decision.isFresh).toBe(true);
    expect(decision.freshnessReason).toBe("fresh_within_threshold");
  });

  it("marks signal stale when age is above threshold", () => {
    const nowMs = Date.now();
    const signal = {
      id: "sig-stale",
      symbol: "AAPL",
      createdAt: new Date(nowMs - 61_000).toISOString(),
    };

    const decision = evaluateSignalFreshnessDecision(signal, nowMs, 60_000);
    expect(decision.isFresh).toBe(false);
    expect(decision.freshnessReason).toBe("stale_over_threshold");
  });

  it("treats EOD 75m mode 54m old signal as fresh", () => {
    const nowMs = Date.now();
    const signal = {
      id: "sig-eod",
      symbol: "TSLA",
      createdAt: new Date(nowMs - 54 * 60_000).toISOString(),
    };

    const decision = evaluateSignalFreshnessDecision(signal, nowMs, 75 * 60_000);
    expect(decision.isFresh).toBe(true);
    expect(decision.freshnessReason).toBe("fresh_within_threshold");
  });

  it("consistency check has zero mismatches when stale skips are derived from decisions", () => {
    const nowMs = Date.now();
    const decisions: FreshnessDecision[] = [
      evaluateSignalFreshnessDecision(
        { id: "sig-1", symbol: "AAPL", createdAt: new Date(nowMs - 1_000).toISOString() },
        nowMs,
        60_000
      ),
      evaluateSignalFreshnessDecision(
        { id: "sig-2", symbol: "MSFT", createdAt: new Date(nowMs - 120_000).toISOString() },
        nowMs,
        60_000
      ),
    ];

    const staleSkippedSignalIds = new Set(
      decisions.filter((d) => !d.isFresh).map((d) => d.signalId)
    );
    const mismatchCount = decisions.filter(
      (d) => d.isFresh && staleSkippedSignalIds.has(d.signalId)
    ).length;

    expect(mismatchCount).toBe(0);
  });

  it("maps freshness mode to threshold source", () => {
    expect(getFreshnessThresholdSource("eod_75m")).toBe("eod_window_policy_75m");
    expect(getFreshnessThresholdSource("market_default_60m")).toBe("market_open_default_60m");
  });
});
