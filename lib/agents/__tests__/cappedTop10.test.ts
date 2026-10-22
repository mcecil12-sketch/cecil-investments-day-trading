import { describe, expect, it } from "vitest";
import { CAPPED_MAX_PER_SECTOR, CAPPED_TOP_N, computeCappedTop10, sectorCounts } from "@/lib/agents/cappedTop10";

const mk = (sectors: string[]) => sectors.map((sector, i) => ({ symbol: `S${i + 1}`, sector, rank: i + 1 }));
const result = (sectors: string[]) => Object.fromEntries(computeCappedTop10(mk(sectors)).map((r) => [r.symbol, r]));

describe("computeCappedTop10 (shadow, max 3 per sector)", () => {
  it("constants", () => {
    expect([CAPPED_MAX_PER_SECTOR, CAPPED_TOP_N]).toEqual([3, 10]);
  });

  it("keeps the pure top 10 when no sector exceeds the cap", () => {
    const r = result(["A", "A", "A", "B", "B", "B", "C", "C", "C", "D", "E", "E"]);
    for (let i = 1; i <= 10; i++) expect(r[`S${i}`]).toMatchObject({ cappedRank: i, inCappedTop10: true });
    expect(r.S11.inCappedTop10).toBe(false);
    expect(r.S11.cappedRank).toBe(11); // still ranked in the capped ordering, just outside the top 10
  });

  it("overflow past 3 in a sector is replaced by the next-ranked candidate from a sector still under the cap", () => {
    // 5 Tech at ranks 1-5, then Energy, Health, Tech, Utilities, Financials, Industrials, Materials ...
    const sectors = ["Tech", "Tech", "Tech", "Tech", "Tech", "Energy", "Health", "Tech", "Utilities", "Financials", "Industrials", "Materials"];
    const r = result(sectors);
    expect(r.S5).toMatchObject({ cappedRank: null, inCappedTop10: false });
    expect(r.S8).toMatchObject({ cappedRank: null, inCappedTop10: false }); // later Tech also over the cap
    // Replacements walk in on rank order: S6..S7, S9..S12 fill capped ranks 4..9, ... until 10
    expect(r.S6.cappedRank).toBe(4);
    expect(r.S7.cappedRank).toBe(5);
    expect(r.S9.cappedRank).toBe(6);
    expect(r.S12.cappedRank).toBe(9);
    const inTop = Object.values(r).filter((x) => x.inCappedTop10);
    // 9 kept under the cap; the fill pass takes the best overflow name (S4, a 4th Tech) as #10
    expect(inTop).toHaveLength(10);
    expect(r.S4).toMatchObject({ cappedRank: 10, inCappedTop10: true });
  });

  it("fills a full 10 from a deeper list and never exceeds 3 per sector", () => {
    const sectors = Array.from({ length: 30 }, (_, i) => (i < 8 ? "Tech" : i < 14 ? "Energy" : ["Health", "Utilities", "Financials", "Industrials", "Materials"][i % 5]));
    const out = computeCappedTop10(mk(sectors));
    const top = out.filter((r) => r.inCappedTop10);
    expect(top).toHaveLength(10);
    const counts: Record<string, number> = {};
    for (const t of top) {
      const sector = sectors[Number(t.symbol.slice(1)) - 1];
      counts[sector] = (counts[sector] ?? 0) + 1;
    }
    expect(Math.max(...Object.values(counts))).toBeLessThanOrEqual(3);
    // capped ranks are 1..N in walk order, no gaps among kept names
    const ranks = out.map((r) => r.cappedRank).filter((x): x is number => x != null);
    expect(ranks).toEqual(ranks.map((_, i) => i + 1));
  });

  it("is independent of input order and returns results in input order", () => {
    const input = mk(["A", "A", "A", "A", "B"]);
    const shuffled = [input[4], input[1], input[3], input[0], input[2]];
    const out = computeCappedTop10(shuffled);
    expect(out.map((r) => r.symbol)).toEqual(shuffled.map((c) => c.symbol));
    expect(Object.fromEntries(out.map((r) => [r.symbol, r.cappedRank]))).toEqual({ S1: 1, S2: 2, S3: 3, S4: 5, S5: 4 }); // S4 enters on the fill pass
  });

  it("handles empty and small lists", () => {
    expect(computeCappedTop10([])).toEqual([]);
    // 3 under the cap, then the fill pass allows a 4th from the same sector
    expect(computeCappedTop10(mk(["A", "A", "A", "A", "A"])).filter((r) => r.inCappedTop10)).toHaveLength(4);
  });

  it("three-sector month: 3+3+3 under the cap, 10th is the next-highest name in any sector", () => {
    // Oct 2026 shape: 7 Tech ranked first, then 2 Energy, 1 Health, more Tech, then Energy/Health further down
    const sectors = ["T", "T", "T", "T", "T", "T", "E", "E", "H", "T", "H", "T", "T", "E", "H"];
    const out = computeCappedTop10(mk(sectors));
    const top = out.filter((r) => r.inCappedTop10).sort((a, b) => a.cappedRank! - b.cappedRank!).map((r) => r.symbol);
    expect(top).toEqual(["S1", "S2", "S3", "S7", "S8", "S9", "S11", "S14", "S15", "S4"]);
  });

  it("sectorCounts sorts by count then name", () => {
    expect(sectorCounts([{ sector: "B" }, { sector: "A" }, { sector: "A" }, { sector: "C" }])).toEqual({ A: 2, B: 1, C: 1 });
  });
});
