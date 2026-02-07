import { describe, expect, test } from "vitest";
import { computeScoringWindows } from "@/lib/ops/scoringWindows";

describe("computeScoringWindows", () => {
  test("computes created and scored windows separately", () => {
    const now = new Date("2026-02-07T12:00:00Z");
    const signals = [
      {
        id: "s1",
        status: "PENDING",
        createdAt: "2026-02-07T10:00:00Z",
      },
      {
        id: "s2",
        status: "SCORED",
        createdAt: "2026-02-07T05:00:00Z",
        updatedAt: "2026-02-07T11:00:00Z",
      },
      {
        id: "s3",
        status: "ERROR",
        createdAt: "2026-02-07T04:00:00Z",
        updatedAt: "2026-02-07T11:30:00Z",
      },
      {
        id: "s4",
        status: "SCORED",
        createdAt: "2026-02-07T11:00:00Z",
        scoredAt: "2026-02-07T11:45:00Z",
      },
    ];

    const result = computeScoringWindows(signals, now);

    expect(result.createdLast6Hours.total).toBe(2);
    expect(result.createdLast6Hours.pending).toBe(1);
    expect(result.createdLast6Hours.scored).toBe(1);
    expect(result.createdLast6Hours.error).toBe(0);

    expect(result.scoredLast6Hours.total).toBe(3);
    expect(result.scoredLast6Hours.scored).toBe(2);
    expect(result.scoredLast6Hours.error).toBe(1);
    expect(result.scoredLast6Hours.lastScoredAt).toBe("2026-02-07T11:45:00Z");
  });
});
