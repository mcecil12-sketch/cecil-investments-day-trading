import { describe, expect, it } from "vitest";
import { groupIntoCappedMonthlyRankings, heldMonths, heldVariantForBatch, latestSellList } from "@/lib/agents/group3Variant";

const sep = new Date("2026-09-01T06:00:00Z");
const oct = new Date("2026-10-01T06:00:00Z");
const nov = new Date("2026-11-01T06:00:00Z");

function batch(tag: string, date: Date, list: Array<[string, string]>) {
  return list.map(([symbol, sector], i) => ({ symbol, sector, batchTag: tag, recommendedAt: date, score: 100 - i, rank: i + 1 }));
}

// October 2026 shape: 7 Tech in the pure top 10.
const octList: Array<[string, string]> = [
  ["DELL", "Tech"], ["STX", "Tech"], ["MU", "Tech"], ["SNDK", "Tech"], ["AMD", "Tech"], ["ANET", "Tech"],
  ["VLO", "Energy"], ["MPC", "Energy"], ["MRNA", "Health"], ["MRVL", "Tech"], ["AMGN", "Health"], ["PSX", "Energy"], ["TMO", "Health"],
];

describe("group3 variants", () => {
  it("held variant switches to capped from the Nov 1, 2026 scan", () => {
    expect(heldVariantForBatch(oct)).toBe("pure");
    expect(heldVariantForBatch(nov)).toBe("capped");
  });

  it("capped October list: 3 per sector, then the next-highest name in any sector", () => {
    const [month] = groupIntoCappedMonthlyRankings(batch("monthly-2026-10", oct, octList));
    expect(month.rankedSymbols.slice(0, 10).map((s) => s.symbol)).toEqual([
      "DELL", "STX", "MU", "VLO", "MPC", "MRNA", "AMGN", "PSX", "TMO", "SNDK",
    ]);
  });

  it("sell list across the switch: last month's pure holdings that are not on the new capped list", () => {
    const rows = [...batch("monthly-2026-10", oct, octList), ...batch("monthly-2026-11", nov, octList)];
    const months = heldMonths(rows);
    expect(months.map((m) => m.variant)).toEqual(["pure", "capped"]);
    expect(latestSellList(rows).sort()).toEqual(["AMD", "ANET", "MRVL"]);
  });

  it("no sells with a single month", () => {
    expect(latestSellList(batch("monthly-2026-09", sep, octList))).toEqual([]);
  });
});
