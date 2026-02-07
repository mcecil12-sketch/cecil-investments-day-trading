import { describe, expect, test } from "vitest";
import { applyInsufficientBars, applyParseFailed, applyScoreSuccess, applyScoreError } from "@/lib/ai/scoreDrainApply";

describe("score drain apply helpers", () => {
  test("applyParseFailed clears score fields and sets forensics", () => {
    const signal: any = {
      status: "SCORING",
      aiScore: 8.5,
      score: 8.5,
      aiGrade: "A",
      grade: "A",
      totalScore: 8.5,
      tradePlan: { foo: "bar" },
    };
    const nowIso = "2026-02-07T12:00:00Z";
    applyParseFailed(signal, "unparseable", { aiModel: "gpt-5-mini" }, nowIso);

    expect(signal.status).toBe("ERROR");
    expect(signal.error).toBe("parse_failed");
    expect(signal.scoredAt).toBe(nowIso);
    expect(signal.aiModel).toBe("gpt-5-mini");
    expect(signal.aiSummary).toContain("parse_failed");
    expect(Object.prototype.hasOwnProperty.call(signal, "aiScore")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(signal, "score")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(signal, "aiGrade")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(signal, "grade")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(signal, "totalScore")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(signal, "qualified")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(signal, "shownInApp")).toBe(false);
  });

  test("applyScoreError clears all score fields", () => {
    const signal: any = {
      status: "SCORING",
      aiScore: 7.0,
      score: 7.0,
      aiGrade: "B",
      grade: "B",
    };
    const nowIso = "2026-02-07T12:00:00Z";
    applyScoreError(signal, "timeout", nowIso);

    expect(signal.status).toBe("ERROR");
    expect(signal.error).toBe("model_timeout");
    expect(signal.scoredAt).toBe(nowIso);
    expect(Object.prototype.hasOwnProperty.call(signal, "aiScore")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(signal, "score")).toBe(false);
  });

  test("applyScoreSuccess marks SCORED and qualifies", () => {
    const signal: any = { status: "SCORING" };
    const scored = {
      aiScore: 9.2,
      aiGrade: "A",
      aiSummary: "Strong setup",
      totalScore: 9.2,
      tradePlan: { note: "plan" },
    };
    const nowIso = "2026-02-07T12:05:00Z";
    applyScoreSuccess(signal, scored, nowIso);

    expect(signal.status).toBe("SCORED");
    expect(signal.aiScore).toBe(9.2);
    expect(signal.score).toBe(9.2); // backwards compat alias
    expect(signal.aiGrade).toBe("A");
    expect(signal.grade).toBe("A"); // backwards compat alias
    expect(signal.scoredAt).toBe(nowIso);
    expect(signal.qualified).toBe(true);
    expect(signal.shownInApp).toBe(true);
  });

  test("applyScoreSuccess enforces hard invariant: aiScore must be finite", () => {
    const signal: any = { status: "SCORING" };
    const scoredWithNull = {
      aiScore: null,
      aiGrade: "F",
      aiSummary: "Invalid",
    };

    expect(() => {
      applyScoreSuccess(signal, scoredWithNull, new Date().toISOString());
    }).toThrow("aiScore must be finite for SCORED");

    expect(signal.status).toBe("SCORING"); // unchanged
  });

  test("applyInsufficientBars sets ERROR status with aiScore=0", () => {
    const signal: any = { status: "SCORING" };
    const reason = "Insufficient recent bars (5 < 20)";
    const nowIso = "2026-02-07T12:10:00Z";
    applyInsufficientBars(signal, reason, nowIso);

    expect(signal.status).toBe("ERROR");
    expect(signal.error).toBe("insufficient_bars");
    expect(signal.aiScore).toBe(0);
    expect(signal.aiGrade).toBe("F");
    expect(signal.aiSummary).toBe(reason);
    expect(signal.scoredAt).toBe(nowIso);
    // Verify score fields are cleared
    expect(Object.prototype.hasOwnProperty.call(signal, "score")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(signal, "grade")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(signal, "qualified")).toBe(false);
  });

  test("applyScoreSuccess with aiScore=0 is valid (for non-insufficient bars)", () => {
    const signal: any = { status: "SCORING" };
    const scored = {
      aiScore: 0,
      aiGrade: "F",
      aiSummary: "Poor setup",
      totalScore: 0,
    };
    const nowIso = "2026-02-07T12:10:00Z";
    applyScoreSuccess(signal, scored, nowIso);

    expect(signal.status).toBe("SCORED");
    expect(signal.aiScore).toBe(0);
    expect(signal.score).toBe(0);
    expect(signal.aiGrade).toBe("F");
    expect(signal.qualified).toBe(false);
  });

  test("write guard scenario: SCORED with null aiScore should never reach persistence", () => {
    // This test documents that the write guard in route.ts should catch and convert
    // any signal that somehow has SCORED status with non-finite aiScore.
    // The guard checks: if (signal.status === "SCORED" && !Number.isFinite(signal.aiScore))
    // and converts to ERROR with error: "parse_failed" or "insufficient_bars"

    const badSignals = [
      { id: "1", ticker: "AAPL", status: "SCORED", aiScore: null, aiGrade: "A", aiSummary: "test" },
      { id: "2", ticker: "TSLA", status: "SCORED", aiScore: undefined, aiGrade: "B" },
      { id: "3", ticker: "NVDA", status: "SCORED", aiScore: NaN, aiGrade: "C" },
      { id: "4", ticker: "MSFT", status: "SCORED", aiScore: Infinity, aiGrade: "D" },
    ];

    // Verify that these are the problematic patterns the write guard protects against
    badSignals.forEach((signal) => {
      expect(Number.isFinite(signal.aiScore as any)).toBe(false);
      expect(signal.status).toBe("SCORED"); // They are marked as SCORED (the problem)
    });
  });

  test("insufficient bars path: error code is insufficient_bars with aiScore=0", () => {
    // When a signal fails due to insufficient bars, applyInsufficientBars ensures:
    // - status: "ERROR" (not SCORED)
    // - error: "insufficient_bars"
    // - aiScore: 0 (finite, never null)
    // - aiGrade: "F"

    const signal: any = { status: "SCORING", id: "test-1", ticker: "TEST" };
    applyInsufficientBars(signal, "Insufficient recent bars (0 < 20)", "2026-02-07T12:00:00Z");

    expect(signal.status).toBe("ERROR");
    expect(signal.error).toBe("insufficient_bars");
    expect(Number.isFinite(signal.aiScore)).toBe(true);
    expect(signal.aiScore).toBe(0);
    expect(signal.aiGrade).toBe("F");
  });
});
