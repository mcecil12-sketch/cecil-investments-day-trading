import { describe, expect, it } from "vitest";
import {
  evaluatePendingEligibility,
  pickCanonicalPendingByTicker,
  type EligibilityConfig,
} from "@/lib/autoEntry/eligibility";

function isoMinutesAgo(mins: number) {
  return new Date(Date.now() - mins * 60_000).toISOString();
}

const cfg: EligibilityConfig = {
  todayET: new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date()),
  currentSessionTag: "RTH",
  maxAgeMin: 15,
  rescoreMaxAgeMin: 30,
  rescoreEnabled: true,
  rescoreOnce: true,
};

function baseTrade(overrides: Record<string, any> = {}) {
  return {
    id: crypto.randomUUID(),
    ticker: "AAPL",
    side: "LONG",
    entryPrice: 100,
    stopPrice: 98,
    takeProfitPrice: 104,
    aiScore: 8,
    qualified: true,
    scoredAt: isoMinutesAgo(5),
    createdAt: isoMinutesAgo(5),
    etDate: cfg.todayET,
    sessionTag: "RTH",
    ...overrides,
  };
}

describe("autoEntry eligibility", () => {
  it("classifies age windows correctly", () => {
    const now = new Date().toISOString();

    const fresh = evaluatePendingEligibility(baseTrade({ scoredAt: isoMinutesAgo(10) }), now, cfg);
    expect(fresh.eligible).toBe(true);
    expect(fresh.reason).toBe("eligible");

    const rescore = evaluatePendingEligibility(baseTrade({ scoredAt: isoMinutesAgo(20) }), now, cfg);
    expect(rescore.eligible).toBe(false);
    expect(rescore.reason).toBe("rescore_required");
    expect(rescore.requiresRescore).toBe(true);

    const stale = evaluatePendingEligibility(baseTrade({ scoredAt: isoMinutesAgo(40) }), now, cfg);
    expect(stale.eligible).toBe(false);
    expect(stale.reason).toBe("stale_trade");
  });

  it("returns stale_session for day/session mismatch", () => {
    const now = new Date().toISOString();
    const mismatch = evaluatePendingEligibility(
      baseTrade({ etDate: "1999-01-01", sessionTag: "PRE", scoredAt: isoMinutesAgo(5) }),
      now,
      cfg
    );
    expect(mismatch.eligible).toBe(false);
    expect(mismatch.reason).toBe("stale_session");
  });

  it("keeps newest canonical trade per ticker", () => {
    const older = baseTrade({ id: "old", ticker: "TSLA", scoredAt: isoMinutesAgo(20), createdAt: isoMinutesAgo(20) });
    const newer = baseTrade({ id: "new", ticker: "TSLA", scoredAt: isoMinutesAgo(3), createdAt: isoMinutesAgo(3) });
    const other = baseTrade({ id: "other", ticker: "NVDA", scoredAt: isoMinutesAgo(4), createdAt: isoMinutesAgo(4) });

    const { canonical, duplicates } = pickCanonicalPendingByTicker([older, newer, other]);

    expect(canonical.map((t) => t.id).sort()).toEqual(["new", "other"].sort());
    expect(duplicates.map((t) => t.id)).toContain("old");
  });
});
