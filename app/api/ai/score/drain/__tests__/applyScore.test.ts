import { describe, expect, test } from "vitest";
import { applyParseFailed, applyScoreSuccess } from "@/lib/ai/scoreDrainApply";

describe("score drain apply helpers", () => {
  test("applyParseFailed clears score fields and sets forensics", () => {
    const signal: any = {
      status: "SCORING",
      aiScore: 8.5,
      aiGrade: "A",
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
    expect(Object.prototype.hasOwnProperty.call(signal, "aiGrade")).toBe(false);
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
    expect(signal.aiGrade).toBe("A");
    expect(signal.scoredAt).toBe(nowIso);
    expect(signal.qualified).toBe(true);
    expect(signal.shownInApp).toBe(true);
  });
});
