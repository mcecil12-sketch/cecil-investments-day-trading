import { describe, expect, it } from "vitest";
import { classifyScanHealth } from "@/lib/agents/scanHealth";

const healthyMonthly = {
  kind: "MONTHLY_SCAN" as const,
  rowsLogged: 30,
  expectedRows: 30,
  fragilityPopulatedRows: 30,
  insiderApplicable: true,
  insiderAttemptedRows: 30,
  insiderDeadlineHit: false,
  claudeFailures: [],
};

describe("classifyScanHealth", () => {
  it("is HEALTHY when everything is in order", () => {
    const r = classifyScanHealth(healthyMonthly);
    expect(r.status).toBe("HEALTHY");
    expect(r.reasons).toEqual([]);
  });

  it("DEGRADED: fewer rows than expected", () => {
    const r = classifyScanHealth({ ...healthyMonthly, rowsLogged: 28, fragilityPopulatedRows: 28, insiderAttemptedRows: 28 });
    expect(r.status).toBe("DEGRADED");
    expect(r.reasons[0]).toMatch(/Only 28 rows logged, expected 30/);
  });

  it("DEGRADED: more than 20% null fragility fields (exactly 20% is fine)", () => {
    expect(classifyScanHealth({ ...healthyMonthly, fragilityPopulatedRows: 24 }).status).toBe("HEALTHY");
    const r = classifyScanHealth({ ...healthyMonthly, fragilityPopulatedRows: 23 });
    expect(r.status).toBe("DEGRADED");
    expect(r.reasons.join()).toMatch(/null extensionVs200d\/vol60d/);
  });

  it("DEGRADED: fewer than 80% insider rows attempted (exactly 80% is fine)", () => {
    expect(classifyScanHealth({ ...healthyMonthly, insiderAttemptedRows: 24 }).status).toBe("HEALTHY");
    const r = classifyScanHealth({ ...healthyMonthly, insiderAttemptedRows: 23 });
    expect(r.status).toBe("DEGRADED");
    expect(r.reasons.join()).toMatch(/Insider pass attempted 23\/30/);
  });

  it("DEGRADED: insider deadline hit", () => {
    const r = classifyScanHealth({ ...healthyMonthly, insiderDeadlineHit: true });
    expect(r.status).toBe("DEGRADED");
    expect(r.reasons.join()).toMatch(/deadline/);
  });

  it("DEGRADED: any Claude failure, with the reason surfaced", () => {
    const r = classifyScanHealth({
      kind: "WEEKLY_BRIEF",
      claudeFailures: [{ source: "CIO brief", reason: "BILLING/CREDIT: credit balance is too low" }],
    });
    expect(r.status).toBe("DEGRADED");
    expect(r.reasons[0]).toContain("BILLING/CREDIT");
  });

  it("FAILED: run failure or zero rows", () => {
    expect(classifyScanHealth({ kind: "MONTHLY_SCAN", runFailed: "boom" }).status).toBe("FAILED");
    expect(classifyScanHealth({ ...healthyMonthly, rowsLogged: 0 }).status).toBe("FAILED");
  });

  it("weekly scans skip the expected-row and insider checks", () => {
    const r = classifyScanHealth({ kind: "WEEKLY_SCAN", rowsLogged: 11, expectedRows: null, fragilityPopulatedRows: 11, insiderApplicable: false });
    expect(r.status).toBe("HEALTHY");
  });

  it("carries the metrics", () => {
    const r = classifyScanHealth({ ...healthyMonthly, sentimentCoveredSymbols: 140, durationMs: 90_000, limitMs: 240_000, insiderCounters: { insiderCallsUsed: 30, insiderSucceeded: 29, insiderFailed: 1, insiderSkippedByDeadline: 0 } });
    expect(r.metrics).toMatchObject({ rowsLogged: 30, sentimentCoveredSymbols: 140, durationMs: 90_000, limitMs: 240_000, insiderFailed: 1 });
  });
});
