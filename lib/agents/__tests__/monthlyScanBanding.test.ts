import { describe, expect, it } from "vitest";
import {
  buildBandedMonthlyPositions,
  buildFullRankTrackedPositions,
  currentlyHeldSymbols,
  BUY_RANK_THRESHOLD,
  SELL_RANK_THRESHOLD,
  TARGET_PORTFOLIO_SIZE,
  MAX_PORTFOLIO_SIZE,
  type MonthlyRanking,
} from "@/lib/agents/monthlyScanBanding";

function monthDate(n: number): Date {
  return new Date(Date.UTC(2026, n, 1));
}

/** Ranked list of n symbols named S1..Sn, best (rank 1) first, score descending. */
function ranked(symbols: string[]): Array<{ symbol: string; score: number }> {
  return symbols.map((symbol, i) => ({ symbol, score: 100 - i }));
}

function batch(n: number, symbols: string[]): MonthlyRanking {
  return { monthKey: `2026-${n + 1}`, date: monthDate(n), rankedSymbols: ranked(symbols) };
}

describe("buildBandedMonthlyPositions", () => {
  it("buys the top TARGET_PORTFOLIO_SIZE symbols on the first month (backfill from empty)", () => {
    const symbols = Array.from({ length: 15 }, (_, i) => `S${i + 1}`);
    const positions = buildBandedMonthlyPositions([batch(0, symbols)]);
    const held = positions.filter((p) => p.exitDate == null).map((p) => p.symbol).sort();
    expect(held).toEqual(symbols.slice(0, TARGET_PORTFOLIO_SIZE).sort());
  });

  it("sells a held symbol the moment its rank is 11 or worse — no whipsaw buffer (SELL_RANK_THRESHOLD == BUY_RANK_THRESHOLD)", () => {
    // Month 0: S1 enters at rank 1. Month 1: S1 has drifted to rank 11 — under the old 20-rank
    // buffer this would have stayed held; the hard top-10 rule now sells it immediately.
    const month0Symbols = ["S1", ...Array.from({ length: 9 }, (_, i) => `X${i}`)];
    const month1Symbols = [...Array.from({ length: 10 }, (_, i) => `X${i}`), "S1"]; // S1 now rank 11
    const positions = buildBandedMonthlyPositions([batch(0, month0Symbols), batch(1, month1Symbols)]);
    const s1 = positions.find((p) => p.symbol === "S1")!;
    expect(s1.exitDate).toEqual(monthDate(1));
  });

  it("sells a held symbol once its rank drops below SELL_RANK_THRESHOLD (below 10)", () => {
    const month0Symbols = ["S1", ...Array.from({ length: 9 }, (_, i) => `X${i}`)]; // S1 rank 1, 10 held after backfill
    // Month 1: S1 pushed to rank 25 (30 total ranked, S1 at position 25) — below SELL_RANK_THRESHOLD.
    const filler = Array.from({ length: 29 }, (_, i) => `Y${i}`);
    const month1Symbols = [...filler.slice(0, 24), "S1", ...filler.slice(24)];
    const positions = buildBandedMonthlyPositions([batch(0, month0Symbols), batch(1, month1Symbols)]);
    const s1 = positions.find((p) => p.symbol === "S1" && p.exitDate != null);
    expect(s1).toBeDefined();
    expect(s1!.exitDate).toEqual(monthDate(1));
  });

  it("backfills from the next-highest-ranked unheld names when sells drop the count below TARGET_PORTFOLIO_SIZE", () => {
    const initial = Array.from({ length: 10 }, (_, i) => `H${i}`); // 10 held after month 0
    // Month 1: all 10 originally-held names fall off the ranking entirely (implicit sell), replaced by 15 fresh names.
    const fresh = Array.from({ length: 15 }, (_, i) => `F${i}`);
    const positions = buildBandedMonthlyPositions([batch(0, initial), batch(1, fresh)]);
    const heldAfter = positions.filter((p) => p.exitDate == null).map((p) => p.symbol).sort();
    expect(heldAfter).toEqual(fresh.slice(0, TARGET_PORTFOLIO_SIZE).sort());
  });

  it("caps held positions at MAX_PORTFOLIO_SIZE — a full monthly rotation replaces the portfolio rather than exceeding the cap", () => {
    // With the 2026-10-02 hard-top-10 change, MAX_PORTFOLIO_SIZE == TARGET_PORTFOLIO_SIZE ==
    // BUY_RANK_THRESHOLD == SELL_RANK_THRESHOLD (10), so there's no gap left between "sold" and
    // "capped" to exercise independently — any held symbol pushed past rank 10 is sold outright
    // (no more surviving in an 11-20 buffer zone the way MAX_PORTFOLIO_SIZE=15/SELL=20 used to allow).
    const aSymbols = Array.from({ length: 10 }, (_, i) => `A${i}`);
    const bSymbols = Array.from({ length: 10 }, (_, i) => `B${i}`);

    // Month 0: A0-A9 are the top 10 -> all 10 bought.
    const month0 = [...aSymbols, ...Array.from({ length: 10 }, (_, i) => `X${i}`)];
    // Month 1: B0-B9 take ranks 1-10, pushing every A to rank 11+ -> all sold under the new hard
    // top-10 rule (previously, within the old 20-rank buffer, they'd have stayed held).
    const month1 = [...bSymbols, ...aSymbols];

    const positions = buildBandedMonthlyPositions([batch(0, month0), batch(1, month1)]);
    const held = new Set(positions.filter((p) => p.exitDate == null).map((p) => p.symbol));

    expect(held.size).toBe(MAX_PORTFOLIO_SIZE);
    for (const s of bSymbols) expect(held.has(s)).toBe(true);
    for (const s of aSymbols) expect(held.has(s)).toBe(false);
  });

  it("respects BUY_RANK_THRESHOLD and SELL_RANK_THRESHOLD as the configured constants (sanity check on exported values)", () => {
    expect(BUY_RANK_THRESHOLD).toBe(10);
    expect(SELL_RANK_THRESHOLD).toBe(10);
    expect(TARGET_PORTFOLIO_SIZE).toBe(10);
    expect(MAX_PORTFOLIO_SIZE).toBe(10);
  });
});

describe("currentlyHeldSymbols", () => {
  it("returns only symbols with no exitDate as of the latest month", () => {
    const symbols = Array.from({ length: 10 }, (_, i) => `S${i}`);
    const held = currentlyHeldSymbols([batch(0, symbols)]);
    expect(held.size).toBe(TARGET_PORTFOLIO_SIZE);
    for (const s of symbols) expect(held.has(s)).toBe(true);
  });
});

describe("buildFullRankTrackedPositions", () => {
  it("tracks every symbol in the batch, not just the top BUY_RANK_THRESHOLD", () => {
    const symbols = Array.from({ length: 30 }, (_, i) => `S${i}`);
    const positions = buildFullRankTrackedPositions([batch(0, symbols)]);
    const open = positions.filter((p) => p.exitDate == null).map((p) => p.symbol).sort();
    expect(open).toEqual([...symbols].sort());
  });

  it("closes a symbol the very first month it's absent — no grace period", () => {
    const month0 = ["S1", ...Array.from({ length: 29 }, (_, i) => `X${i}`)];
    const month1 = Array.from({ length: 29 }, (_, i) => `X${i}`); // S1 dropped out of the top 30 entirely
    const positions = buildFullRankTrackedPositions([batch(0, month0), batch(1, month1)]);
    const s1 = positions.find((p) => p.symbol === "S1")!;
    expect(s1.exitDate).toEqual(monthDate(1));
  });

  it("treats re-entry after a close as a brand-new position with a fresh cost basis", () => {
    const month0 = ["S1", ...Array.from({ length: 29 }, (_, i) => `X${i}`)];
    const month1 = Array.from({ length: 29 }, (_, i) => `X${i}`); // S1 absent — closes
    const month2 = ["S1", ...Array.from({ length: 29 }, (_, i) => `X${i}`)]; // S1 reappears
    const positions = buildFullRankTrackedPositions([batch(0, month0), batch(1, month1), batch(2, month2)]);
    const s1Positions = positions.filter((p) => p.symbol === "S1");
    expect(s1Positions).toHaveLength(2);
    expect(s1Positions[0].exitDate).toEqual(monthDate(1));
    expect(s1Positions[1].entryDate).toEqual(monthDate(2));
    expect(s1Positions[1].exitDate).toBeNull();
  });

  it("keeps tracking a symbol that stays in the 11-30 range without ever being bought by the Top 10 banding", () => {
    const symbols = Array.from({ length: 30 }, (_, i) => `S${i}`); // S20 sits at rank 21 every month
    const positions = buildFullRankTrackedPositions([batch(0, symbols), batch(1, symbols)]);
    const s20 = positions.find((p) => p.symbol === "S20")!;
    expect(s20.exitDate).toBeNull();
    expect(s20.entryDate).toEqual(monthDate(0));
  });
});
