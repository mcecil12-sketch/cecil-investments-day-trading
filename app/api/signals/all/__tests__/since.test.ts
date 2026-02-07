import { describe, expect, test } from "vitest";
import { getSignalTimestampMs, parseSince, resolveSinceField } from "@/lib/signals/since";

describe("signals since parsing", () => {
  test("parses relative durations", () => {
    const nowMs = Date.parse("2026-02-07T12:00:00Z");
    const since = parseSince("6h", nowMs);
    expect(since?.toISOString()).toBe("2026-02-07T06:00:00.000Z");
  });

  test("parses ISO timestamps", () => {
    const since = parseSince("2026-02-06T22:08:46Z", 0);
    expect(since?.toISOString()).toBe("2026-02-06T22:08:46.000Z");
  });

  test("resolves sinceField and timestamp selection", () => {
    const signal = {
      createdAt: "2026-02-07T10:00:00Z",
      updatedAt: "2026-02-07T11:00:00Z",
      scoredAt: "2026-02-07T11:30:00Z",
    };
    expect(resolveSinceField("createdAt")).toBe("createdAt");
    expect(resolveSinceField("updatedAt")).toBe("updatedAt");
    expect(resolveSinceField("scoredAt")).toBe("scoredAt");
    expect(resolveSinceField("" as any)).toBe("createdAt");

    expect(getSignalTimestampMs(signal, "createdAt")).toBe(Date.parse(signal.createdAt));
    expect(getSignalTimestampMs(signal, "updatedAt")).toBe(Date.parse(signal.updatedAt));
    expect(getSignalTimestampMs(signal, "scoredAt")).toBe(Date.parse(signal.scoredAt));
  });
});
