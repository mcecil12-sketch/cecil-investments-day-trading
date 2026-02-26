import { describe, expect, it } from "vitest";
import { getEtDateString } from "@/lib/time/etDate";

describe("getEtDateString", () => {
  it("keeps prior ET date near UTC midnight", () => {
    const utcNearMidnight = new Date("2026-01-01T01:30:00.000Z");
    expect(getEtDateString(utcNearMidnight)).toBe("2025-12-31");
  });

  it("returns same date when UTC time maps to daytime ET", () => {
    const utcDaytime = new Date("2026-01-01T18:00:00.000Z");
    expect(getEtDateString(utcDaytime)).toBe("2026-01-01");
  });
});
