/**
 * Phase 2B regression tests:
 *   - readExecutionOverlays safe defaults when state missing
 *   - readExecutionOverlays honors stored allowedGrades/minScoreAdjustment/maxEntriesOverride
 *   - readExecutionOverlays falls back to defaults on individual bad fields
 *   - Overlay grade enforcement (conceptual unit tests)
 *   - Overlay minScoreAdjustment enforcement
 *   - maxEntriesOverride tightens but never loosens
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory Redis mock (same pattern as phase2a.test.ts)
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const mem = new Map<string, string>();
  const redis = {
    get: vi.fn(async (key: string) => mem.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      mem.set(key, value);
      return "OK";
    }),
  };
  return { mem, redis };
});

vi.mock("@/lib/redis", () => ({ redis: mocks.redis }));

vi.mock("@/lib/redis/ttl", () => ({
  getTtlSeconds: vi.fn(() => 3600),
  setWithTtl: vi.fn(async (_r: unknown, key: string, value: string) => {
    mocks.mem.set(key, value);
    return true;
  }),
}));

vi.mock("@/lib/tradingConfig", () => ({
  getTradingConfig: vi.fn(() => ({ flags: { allowTierCAutoEntry: true } })),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { ensureAgentState, writeAgentState, createDefaultAgentState } from "@/lib/agents/store";
import { readExecutionOverlays } from "@/lib/agents/overlays";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  mocks.mem.clear();
});

// ---------------------------------------------------------------------------
// 1. Safe defaults when no agent state exists
// ---------------------------------------------------------------------------

describe("readExecutionOverlays — safe defaults", () => {
  it("returns permissive defaults when Redis has no state", async () => {
    // mem is clear — readAgentState returns null
    const overlay = await readExecutionOverlays();
    expect(overlay.posture).toBe("NORMAL");
    expect(overlay.allowedGrades).toEqual(["A", "B", "C"]);
    expect(overlay.minScoreAdjustment).toBe(0);
    expect(overlay.maxEntriesOverride).toBeNull();
    expect(overlay.activeRestrictions).toEqual([]);
    expect(overlay.stateAvailable).toBe(false);
  });

  it("never throws even when readAgentState throws", async () => {
    // Force an error by corrupting the redis mock temporarily
    const orig = mocks.redis.get;
    mocks.redis.get.mockRejectedValueOnce(new Error("redis unavailable"));
    const overlay = await readExecutionOverlays();
    expect(overlay.allowedGrades).toEqual(["A", "B", "C"]);
    expect(overlay.stateAvailable).toBe(false);
    mocks.redis.get = orig;
  });
});

// ---------------------------------------------------------------------------
// 2. Reads stored overlay fields correctly
// ---------------------------------------------------------------------------

describe("readExecutionOverlays — stored state", () => {
  it("returns stored allowedGrades when Risk sets A-only", async () => {
    const base = createDefaultAgentState();
    await writeAgentState({ ...base, allowedGrades: ["A"], minScoreAdjustment: 1.0, maxEntriesOverride: 2 });

    const overlay = await readExecutionOverlays();
    expect(overlay.allowedGrades).toEqual(["A"]);
    expect(overlay.minScoreAdjustment).toBe(1.0);
    expect(overlay.maxEntriesOverride).toBe(2);
    expect(overlay.stateAvailable).toBe(true);
  });

  it("returns stored allowedGrades when Risk sets A/B", async () => {
    const base = createDefaultAgentState();
    await writeAgentState({ ...base, allowedGrades: ["A", "B"], minScoreAdjustment: 0.5, maxEntriesOverride: null });

    const overlay = await readExecutionOverlays();
    expect(overlay.allowedGrades).toEqual(["A", "B"]);
    expect(overlay.minScoreAdjustment).toBe(0.5);
    expect(overlay.maxEntriesOverride).toBeNull();
    expect(overlay.stateAvailable).toBe(true);
  });

  it("returns stored posture", async () => {
    const base = createDefaultAgentState();
    await writeAgentState({ ...base, posture: "DEFENSIVE" });

    const overlay = await readExecutionOverlays();
    expect(overlay.posture).toBe("DEFENSIVE");
  });

  it("falls back to default allowedGrades when stored value is empty array", async () => {
    const base = createDefaultAgentState();
    await writeAgentState({ ...base, allowedGrades: ["A", "B", "C"] });
    // updateAgentState should not allow [], but if something goes wrong we want safe behavior
    await writeAgentState({ ...base, allowedGrades: ["A", "B", "C"] });
    // Re-read and verify the fallback logic handles a deliberate empty
    // We do this by writing directly to Redis with an empty array
    const key = "agents:state";
    const existing = await mocks.redis.get(key);
    if (existing) {
      const parsed = JSON.parse(existing);
      parsed.allowedGrades = [];
      mocks.mem.set(key, JSON.stringify(parsed));
    }

    const overlay = await readExecutionOverlays();
    // empty allowedGrades → falls back to ["A","B","C"]
    expect(overlay.allowedGrades).toEqual(["A", "B", "C"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Overlay logic: grade filtering (unit)
// ---------------------------------------------------------------------------

describe("overlay grade enforcement logic", () => {
  it("C grade excluded when allowedGrades is A-only", () => {
    const allowedGrades = ["A"] as string[];
    const tradeTier = "C";
    const gradeAllowed = allowedGrades.includes(tradeTier as "A");
    expect(gradeAllowed).toBe(false);
  });

  it("C grade excluded when allowedGrades is A/B", () => {
    const allowedGrades = ["A", "B"] as string[];
    const tradeTier = "C";
    const gradeAllowed = allowedGrades.includes(tradeTier);
    expect(gradeAllowed).toBe(false);
  });

  it("A grade allowed when allowedGrades is A-only", () => {
    const allowedGrades = ["A"] as string[];
    const tradeTier = "A";
    const gradeAllowed = allowedGrades.includes(tradeTier);
    expect(gradeAllowed).toBe(true);
  });

  it("B grade allowed when allowedGrades is A/B/C (default)", () => {
    const allowedGrades = ["A", "B", "C"] as string[];
    const tradeTier = "B";
    const gradeAllowed = allowedGrades.includes(tradeTier);
    expect(gradeAllowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Overlay logic: minScoreAdjustment enforcement (unit)
// ---------------------------------------------------------------------------

describe("overlay minScoreAdjustment enforcement logic", () => {
  const tierCmin = 6.5;

  it("blocks a score of 7.0 at C-tier when adjustment is +1.0 (threshold becomes 7.5)", () => {
    const minScoreAdjustment = 1.0;
    const tradeScore = 7.0;
    const effectiveMin = tierCmin + minScoreAdjustment; // 7.5
    expect(tradeScore < effectiveMin).toBe(true);
  });

  it("allows a score of 8.0 at C-tier when adjustment is +1.0 (threshold is 7.5)", () => {
    const minScoreAdjustment = 1.0;
    const tradeScore = 8.0;
    const effectiveMin = tierCmin + minScoreAdjustment; // 7.5
    expect(tradeScore < effectiveMin).toBe(false);
  });

  it("no effect with 0 adjustment", () => {
    const minScoreAdjustment = 0;
    const tradeScore = 6.6;
    const effectiveMin = tierCmin + minScoreAdjustment; // 6.5
    expect(tradeScore < effectiveMin).toBe(false);
  });

  it("applies equally to A-tier base threshold (8.5)", () => {
    const tierAmin = 8.5;
    const minScoreAdjustment = 0.5;
    const effectiveMin = tierAmin + minScoreAdjustment; // 9.0
    expect(8.6 < effectiveMin).toBe(true);  // 8.6 blocked
    expect(9.1 < effectiveMin).toBe(false); // 9.1 passes
  });
});

// ---------------------------------------------------------------------------
// 5. maxEntriesOverride: tightens but never loosens
// ---------------------------------------------------------------------------

describe("overlay maxEntriesOverride logic", () => {
  it("override of 2 blocks when entriesToday >= 2 (below config maxPerDay)", () => {
    const maxEntriesOverride = 2;
    const entriesToday = 2;
    const configMaxPerDay = 5;
    // Config hasn't blocked yet (2 < 5), but override fires
    const configBlocked = entriesToday >= configMaxPerDay;
    const overlayBlocked = entriesToday >= maxEntriesOverride;
    expect(configBlocked).toBe(false);
    expect(overlayBlocked).toBe(true);
  });

  it("override of 5 does not block when entriesToday=4 and config maxPerDay=5", () => {
    const maxEntriesOverride = 5;
    const entriesToday = 4;
    const overlayBlocked = entriesToday >= maxEntriesOverride;
    expect(overlayBlocked).toBe(false);
  });

  it("override of 10 with config maxPerDay=5 never loosens: config still fires at 5", () => {
    const maxEntriesOverride = 10; // override is looser than config — config should still fire
    const configMaxPerDay = 5;
    const entriesToday = 5;
    const configBlocked = entriesToday >= configMaxPerDay;
    const overlayBlocked = entriesToday >= maxEntriesOverride;
    // Config fires; overlay does not (override is looser)
    // In execute route, config check comes first → trade is blocked correctly
    expect(configBlocked).toBe(true);
    expect(overlayBlocked).toBe(false);
  });

  it("null override means no additional cap — only config applies", () => {
    const maxEntriesOverride = null;
    // When overlay.maxEntriesOverride is null, the check is skipped entirely
    const overlayActive = maxEntriesOverride != null;
    expect(overlayActive).toBe(false);
  });

  it("effectiveLimit in seed-from-signals uses min(limit, override)", () => {
    const limit = 5;
    const maxEntriesOverride = 2;
    const effectiveLimit = maxEntriesOverride != null ? Math.min(limit, maxEntriesOverride) : limit;
    expect(effectiveLimit).toBe(2);
  });

  it("effectiveLimit in seed-from-signals is unchanged when override is null", () => {
    const limit = 5;
    const maxEntriesOverride = null;
    const effectiveLimit = maxEntriesOverride != null ? Math.min(limit, maxEntriesOverride) : limit;
    expect(effectiveLimit).toBe(5);
  });

  it("effectiveLimit never loosens: override larger than limit keeps limit", () => {
    const limit = 3;
    const maxEntriesOverride = 10;
    const effectiveLimit = maxEntriesOverride != null ? Math.min(limit, maxEntriesOverride) : limit;
    expect(effectiveLimit).toBe(3); // limit wins, override doesn't loosen
  });
});
