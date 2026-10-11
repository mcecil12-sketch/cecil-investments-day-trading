import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ writes: [] as string[], sp500Calls: [] as unknown[] }));

const WRITE_METHODS = /^(create|createMany|update|updateMany|upsert|delete|deleteMany|executeRaw|executeRawUnsafe)$/;

const sectorRun = {
  id: "sector-run-1",
  output: {
    generatedAt: "2026-10-01T00:00:00.000Z",
    topSectors: [{ sector: "Technology", symbol: "XLK", score: 80, rank: 1 }],
    flags: [],
  },
};

vi.mock("@/lib/prisma", () => {
  const read = (model: string, method: string) => {
    if (model === "agentRun" && method === "findFirst") return sectorRun;
    return method === "findMany" ? [] : null;
  };
  const modelProxy = (model: string) =>
    new Proxy(
      {},
      {
        get: (_t, method) => async () => {
          if (WRITE_METHODS.test(String(method))) h.writes.push(`${model}.${String(method)}`);
          return read(model, String(method));
        },
      },
    );
  return {
    prisma: new Proxy(
      {},
      {
        get: (_t, model) => {
          if (model === "$transaction") return async () => void h.writes.push("$transaction");
          return modelProxy(String(model));
        },
      },
    ),
  };
});

function series(startPrice: number, growth: number) {
  return Array.from({ length: 320 }, (_, i) => ({
    date: new Date(Date.UTC(2025, 0, 1) + i * 86_400_000),
    close: startPrice * Math.pow(1 + growth, i),
  }));
}

vi.mock("@/lib/agents/marketData", () => ({
  getSp500Series: vi.fn(async (opts: unknown) => {
    h.sp500Calls.push(opts);
    return series(100, 0.0001);
  }),
  getPriceHistory: vi.fn(async (symbol: string) => ({ symbol, points: series(50, symbol === "AAA" ? 0.003 : 0.002), source: "yahoo" })),
}));

vi.mock("@/lib/agents/scoringShared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agents/scoringShared")>()),
  getMergedCandidateUniverse: vi.fn(async () => ({ Technology: { symbols: ["AAA", "BBB"] } })),
}));

vi.mock("@/lib/agents/earningsSurpriseTrend", () => ({
  getEarningsSurpriseTrendScores: vi.fn(async (symbols: string[]) => new Map(symbols.map((s) => [s, { score: 60, coverage: "sue" }]))),
}));

const { runMonthlyScanAgent } = await import("@/lib/agents/monthlyScan");
const { runMonthlyScanDryRun } = await import("@/lib/agents/monthlyScanDryRun");
const { MOMENTUM_TREND_WEIGHT, EARNINGS_SURPRISE_TREND_WEIGHT, SECTOR_LEADERSHIP_WEIGHT } = await import("@/lib/agents/scoringShared");
const { scorePriceSeries } = await import("@/lib/agents/technicals");

const sale = [{ transaction_date: new Date().toISOString().slice(0, 10), executive: "A", security_type: "Ordinary Shares", acquisition_or_disposal: "S", shares: "10", share_price: "5" }];

beforeEach(() => {
  h.writes.length = 0;
  h.sp500Calls.length = 0;
});

describe("monthly scan dry run", () => {
  it("performs zero write calls and returns a full report", async () => {
    const report = await runMonthlyScanDryRun({ now: Date.now, sleep: async () => {}, fetchRows: async () => sale });
    expect(h.writes).toEqual([]);
    expect(h.sp500Calls).toEqual([{ readOnly: true }]);
    expect(report.triggerSource).toBe("dry_run");
    expect(report.wroteNothing).toBe(true);
    expect(report.maxDurationMs).toBe(240_000);
    expect(report.counts).toMatchObject({ universeSymbols: 2, ranked: 2, wouldWriteRows: 2 });
    expect(report.insider).toMatchObject({ insiderCallsUsed: 2, insiderSucceeded: 2, insiderFailed: 0, insiderSkippedByDeadline: 0 });
    expect(report.top10.map((r) => r.symbol).sort()).toEqual(["AAA", "BBB"]);
    expect(report.top10[0].insiderNetSoldUsd30d).toBe(50);
    expect(Object.keys(report.phaseMs)).toEqual(expect.arrayContaining(["loadSectorRun", "pricesFragilityScoringRanking", "insiderPass"]));
  });

  it("a real (non-dry) scoring run does persist earnings state, proving the guard is what stops writes", async () => {
    await runMonthlyScanAgent("manual");
    expect(h.writes).toContain("$transaction");
    expect(h.sp500Calls).toEqual([{ readOnly: false }]);
  });
});

describe("dry run insider rendering", () => {
  it("an empty response reports null net sold (n/a) and per-ticker diagnostics, not $0", async () => {
    const report = await runMonthlyScanDryRun({ now: Date.now, sleep: async () => {}, fetchRows: async (s) => (s === "AAA" ? { ok: true, rows: [], responseKeys: ["data"] } : sale) });
    expect(report.top10.find((r) => r.symbol === "AAA")!.insiderNetSoldUsd30d).toBeNull();
    expect(report.top10.find((r) => r.symbol === "BBB")!.insiderNetSoldUsd30d).toBe(50);
    expect(report.insider).toMatchObject({ insiderEmpty: 1, insiderSucceeded: 1, insiderFailed: 0 });
    expect(report.insiderByTicker.find((t) => t.symbol === "AAA")).toMatchObject({ status: "empty", rowsReturned: 0, responseKeys: ["data"] });
  });
});

describe("composite and rank output is unchanged", () => {
  it("scores equal the documented weighted formula, ranks follow score, and insider fields stay null at scoring time", async () => {
    const dry = await runMonthlyScanAgent("manual", { dryRun: true });
    const live = await runMonthlyScanAgent("cron");
    const key = (o: typeof dry) => o.rankedCandidates.map((c) => [c.rank, c.symbol, c.score]);
    expect(key(live)).toEqual(key(dry));

    const sectorScore = 80;
    for (const c of live.rankedCandidates) {
      const priced = scorePriceSeries(series(50, c.symbol === "AAA" ? 0.003 : 0.002));
      const expected = Math.round(priced.score * MOMENTUM_TREND_WEIGHT + 60 * EARNINGS_SURPRISE_TREND_WEIGHT + sectorScore * SECTOR_LEADERSHIP_WEIGHT);
      expect(c.score).toBe(Math.max(0, Math.min(100, expected)));
      expect(c.insiderNetSoldUsd30d).toBeNull();
      expect(c.insiderSaleCount30d).toBeNull();
    }
    // The new relative fragility fields are populated but never feed score or rank.
    expect(live.rankedCandidates.every((c) => c.fragilityPercentile != null)).toBe(true);
    const scores = live.rankedCandidates.map((c) => c.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(live.rankedCandidates.map((c) => c.rank)).toEqual([1, 2]);
  });
});
