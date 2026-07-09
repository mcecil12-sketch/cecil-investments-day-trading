import { describe, expect, it } from "vitest";
import { getEtDateStringFromTimestamp, nowIso, parseAgentTimestamp } from "@/lib/agents/time";

describe("agent time helpers", () => {
  it("returns a valid ISO timestamp", () => {
    const value = nowIso();
    expect(Number.isFinite(Date.parse(value))).toBe(true);
    expect(value.endsWith("Z")).toBe(true);
  });

  it("parses legacy short-offset timestamps", () => {
    const parsed = parseAgentTimestamp("2026-04-03T15:00:00-4");
    expect(parsed).not.toBeNull();
    expect(parsed?.toISOString()).toBe("2026-04-03T19:00:00.000Z");
  });

  it("returns ET date from legacy short-offset timestamps", () => {
    const etDate = getEtDateStringFromTimestamp("2026-04-03T15:00:00-4");
    expect(etDate).toBe("2026-04-03");
  });

  it("returns null for invalid values", () => {
    expect(parseAgentTimestamp("not-a-date")).toBeNull();
    expect(getEtDateStringFromTimestamp(null)).toBeNull();
  });
});