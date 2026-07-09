import { describe, expect, it } from "vitest";
import {
  evaluatePendingEligibility,
  pickCanonicalEligibleByTicker,
  type EligibilityConfig,
} from "@/lib/autoEntry/eligibility";

function isoMinutesAgo(mins: number) {
  return new Date(Date.now() - mins * 60_000).toISOString();
}

const cfg: EligibilityConfig = {
  todayET: new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date()),
  currentSessionTag: "CLOSED",
  marketIsOpen: false,
  maxAgeMin: 15,
  rescoreAfterMin: 10,
  blockCarryover: true,
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

    const fresh = evaluatePendingEligibility(baseTrade({ createdAt: isoMinutesAgo(8), updatedAt: isoMinutesAgo(8) }), now, cfg);
    expect(fresh.eligible).toBe(true);
    expect(fresh.reason).toBe("eligible");

    const rescore = evaluatePendingEligibility(baseTrade({ createdAt: isoMinutesAgo(12), updatedAt: isoMinutesAgo(12) }), now, cfg);
    expect(rescore.eligible).toBe(false);
    expect(rescore.reason).toBe("rescore_required");
    expect(rescore.requiresRescore).toBe(true);

    const stale = evaluatePendingEligibility(baseTrade({ createdAt: isoMinutesAgo(20), updatedAt: isoMinutesAgo(20) }), now, cfg);
    expect(stale.eligible).toBe(false);
    expect(stale.reason).toBe("stale_trade");
  });

  it("returns carryover_session for day/session mismatch", () => {
    const now = new Date().toISOString();
    const mismatch = evaluatePendingEligibility(
      baseTrade({ createdAt: "1999-01-01T14:00:00Z", updatedAt: "1999-01-01T14:00:00Z" }),
      now,
      cfg
    );
    expect(mismatch.eligible).toBe(false);
    expect(mismatch.reason).toBe("carryover_session");
  });

  it("chooses newest eligible trade per ticker", () => {
    const staleNewest = baseTrade({ id: "stale-newest", ticker: "TSLA", createdAt: isoMinutesAgo(25), updatedAt: isoMinutesAgo(25) });
    const eligibleOlder = baseTrade({ id: "eligible-older", ticker: "TSLA", createdAt: isoMinutesAgo(8), updatedAt: isoMinutesAgo(8) });
    const other = baseTrade({ id: "other", ticker: "NVDA", createdAt: isoMinutesAgo(6), updatedAt: isoMinutesAgo(6) });

    const chosen = pickCanonicalEligibleByTicker([staleNewest, eligibleOlder, other], new Date().toISOString(), cfg);

    expect(chosen.get("TSLA")?.id).toBe("eligible-older");
    expect(chosen.get("NVDA")?.id).toBe("other");
  });
});
