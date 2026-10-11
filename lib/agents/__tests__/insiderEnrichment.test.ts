import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; symbol: string; rank: number; batchTag: string; insiderFetchedAt: Date | null; insiderNetSoldUsd30d: number | null; marketCap?: number | null; marketCapSource?: string | null; scanClose?: number | null; insiderNetSoldPctOfMarketCap?: number | null; insiderSource?: string | null };
const state = vi.hoisted(() => ({ rows: [] as Row[] }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    candidateRecommendationLog: {
      findFirst: vi.fn(async () => (state.rows[0] ? { batchTag: state.rows[0].batchTag } : null)),
      findMany: vi.fn(async ({ where }: { where: { insiderFetchedAt?: null; marketCapSource?: null; OR?: Array<Record<string, unknown>> } }) => {
        const capQuery = "marketCapSource" in where || (where.OR ?? []).some((o) => "marketCapSource" in o);
        const picked = state.rows.filter((r) =>
          capQuery
            ? where.OR
              ? (r.marketCapSource ?? null) === null || r.marketCapSource === "unavailable"
              : (r.marketCapSource ?? null) === null
            : where.OR
              ? r.insiderFetchedAt == null || r.insiderNetSoldUsd30d == null
              : r.insiderFetchedAt == null,
        );
        return picked.map((r) => ({ id: r.id, symbol: r.symbol, marketCap: r.marketCap ?? null, scanClose: r.scanClose ?? null, insiderNetSoldUsd30d: r.insiderNetSoldUsd30d }));
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        Object.assign(state.rows.find((r) => r.id === where.id)!, data);
      }),
    },
  },
}));

const { runInsiderPass, runMarketCapPass, enrichInsiderForLatestMonthlyScan, INSIDER_PASS_DEADLINE_MS } = await import("@/lib/agents/insiderEnrichment");

const sale = [{ transaction_date: new Date().toISOString().slice(0, 10), executive: "A", security_type: "Ordinary Shares", acquisition_or_disposal: "S", shares: "10", share_price: "5" }];

function seed(n: number) {
  state.rows = Array.from({ length: n }, (_, i) => ({ id: `r${i + 1}`, symbol: `S${i + 1}`, rank: i + 1, batchTag: "monthly-2026-11", insiderFetchedAt: null, insiderNetSoldUsd30d: null, marketCap: null, marketCapSource: null, scanClose: 10 + i, insiderNetSoldPctOfMarketCap: null }));
}

/** A fake clock that advances `step` ms per sleep so the deadline can be hit deterministically. */
function fakeClock(step: number) {
  let t = 0;
  return { now: () => t, sleep: async () => void (t += step) };
}

beforeEach(() => seed(10));

describe("runInsiderPass deadline", () => {
  it("stops cleanly near the deadline and counts the rest as skipped", async () => {
    const clock = fakeClock(10_000);
    const done: string[] = [];
    const result = await runInsiderPass(
      state.rows.map((r) => ({ id: r.id, symbol: r.symbol })),
      { ...clock, deadlineMs: 45_000, fetchRows: async () => sale, onResult: async (item) => void done.push(item.id) },
    );
    expect(result.deadlineHit).toBe(true);
    expect(result.insiderCallsUsed).toBeGreaterThan(0);
    expect(result.insiderCallsUsed).toBeLessThan(10);
    expect(result.insiderSucceeded).toBe(result.insiderCallsUsed);
    expect(result.insiderSkippedByDeadline).toBe(10 - result.insiderCallsUsed);
    expect(done).toHaveLength(result.insiderCallsUsed);
  });

  it("never throws, counting failures and empty responses distinctly", async () => {
    const result = await runInsiderPass(
      [{ id: "a", symbol: "A" }, { id: "b", symbol: "B" }, { id: "c", symbol: "C" }],
      { ...fakeClock(0), fetchRows: async (s) => { if (s === "A") return null; if (s === "B") throw new Error("net"); return []; } },
    );
    expect(result.insiderFailed).toBe(2);
    expect(result.insiderEmpty).toBe(1);
    expect(result.insiderSucceeded).toBe(0);
    expect(result.diagnostics.map((d) => d.status)).toEqual(["failed", "failed", "empty"]);
    expect(result.deadlineHit).toBe(false);
  });

  it("an empty response is 'no data' (null net sold, n/a), never $0; failures carry their reason and response keys", async () => {
    const result = await runInsiderPass(
      [{ id: "a", symbol: "A" }, { id: "b", symbol: "B" }, { id: "c", symbol: "C" }],
      {
        ...fakeClock(0),
        fetchRows: async (s) =>
          s === "A" ? { ok: true, rows: [], responseKeys: ["data"] } : s === "B" ? { ok: false, reason: "Information: premium", responseKeys: ["Information"] } : { ok: true, rows: sale, responseKeys: ["data"] },
      },
    );
    const by = Object.fromEntries(result.diagnostics.map((d) => [d.symbol, d]));
    expect(by.A).toMatchObject({ status: "empty", netSoldUsd: null, rowsReturned: 0, responseKeys: ["data"] });
    expect(by.B).toMatchObject({ status: "failed", failureReason: "Information: premium", responseKeys: ["Information"] });
    expect(by.C).toMatchObject({ status: "ok", netSoldUsd: 50, rowsReturned: 1, rowsInWindow: 1, saleRowsCounted: 1 });
    expect(result.summaries.get("A")).toBeNull();
  });

  it("uses a default deadline of 200s", () => {
    expect(INSIDER_PASS_DEADLINE_MS).toBe(200_000);
  });
});

describe("enrichInsiderForLatestMonthlyScan", () => {
  it("a deadline-stopped pass leaves unattempted rows with insiderFetchedAt null", async () => {
    const res = await enrichInsiderForLatestMonthlyScan({ ...fakeClock(10_000), deadlineMs: 45_000, fetchRows: async () => sale });
    const attempted = state.rows.filter((r) => r.insiderFetchedAt != null);
    const untouched = state.rows.filter((r) => r.insiderFetchedAt == null);
    expect(attempted.length).toBe(res.insiderCallsUsed);
    expect(untouched.length).toBe(res.insiderSkippedByDeadline);
    expect(untouched.length).toBeGreaterThan(0);
    // attempted are the top-ranked first
    expect(attempted.map((r) => r.rank)).toEqual(attempted.map((_, i) => i + 1));
    expect(attempted.every((r) => r.insiderNetSoldUsd30d === 50)).toBe(true);
  });

  it("is resumable and idempotent: a second pass only touches the remaining rows", async () => {
    await enrichInsiderForLatestMonthlyScan({ ...fakeClock(10_000), deadlineMs: 45_000, fetchRows: async () => sale });
    const firstDone = state.rows.filter((r) => r.insiderFetchedAt != null).map((r) => r.id);
    const calls: string[] = [];
    const second = await enrichInsiderForLatestMonthlyScan({ ...fakeClock(0), fetchRows: async (s) => { calls.push(s); return sale; } });
    expect(calls).toHaveLength(10 - firstDone.length);
    expect(calls.some((s) => firstDone.includes(state.rows.find((r) => r.symbol === s)!.id))).toBe(false);
    expect(second.insiderSkippedByDeadline).toBe(0);
    const third = await enrichInsiderForLatestMonthlyScan({ ...fakeClock(0), fetchRows: async () => sale });
    expect(third.insiderCallsUsed).toBe(0);
    expect(state.rows.every((r) => r.insiderFetchedAt != null)).toBe(true);
  });

  it("marks failed attempts as attempted (fields stay null); retryFailed re-attempts only those", async () => {
    await enrichInsiderForLatestMonthlyScan({ ...fakeClock(0), fetchRows: async (s) => (s === "S3" ? null : sale) });
    const s3 = state.rows.find((r) => r.symbol === "S3")!;
    expect(s3.insiderFetchedAt).not.toBeNull();
    expect(s3.insiderNetSoldUsd30d).toBeNull();
    expect((await enrichInsiderForLatestMonthlyScan({ ...fakeClock(0), fetchRows: async () => sale })).insiderCallsUsed).toBe(0);
    const retry = await enrichInsiderForLatestMonthlyScan({ ...fakeClock(0), retryFailed: true, fetchRows: async () => sale });
    expect(retry.insiderCallsUsed).toBe(1);
    expect(s3.insiderNetSoldUsd30d).toBe(50);
  });

  it("returns an error result instead of throwing", async () => {
    const { prisma } = await import("@/lib/prisma");
    vi.mocked(prisma.candidateRecommendationLog.findFirst).mockRejectedValueOnce(new Error("db down"));
    const res = await enrichInsiderForLatestMonthlyScan();
    expect(res.error).toBe("db down");
  });
});

describe("EDGAR valid zero is '$0 / no filings', not n/a", () => {
  const edgarOk = (rows: Array<Record<string, unknown>>) => ({ ok: true as const, rows, responseKeys: ["submissions"], source: "edgar" as const });
  const mRow = (code: string) => ({ transaction_date: new Date().toISOString().slice(0, 10), executive: "A", security_type: "Common Stock", acquisition_or_disposal: code, shares: "100", share_price: "10" });

  it("no Form 4 rows at all, or only non-S/P codes, is no_filings with a stored $0 summary", async () => {
    const r = await runInsiderPass([{ id: "a", symbol: "A" }, { id: "b", symbol: "B" }], {
      ...fakeClock(0),
      fetchRows: async (s) => (s === "A" ? edgarOk([]) : edgarOk([mRow("M"), mRow("F")])),
    });
    expect(r.diagnostics.map((d) => d.status)).toEqual(["no_filings", "no_filings"]);
    expect(r.diagnostics[0].netSoldUsd).toBe(0);
    expect(r.summaries.get("A")).toMatchObject({ insiderNetSoldUsd30d: 0, insiderSaleCount30d: 0 });
    expect(r.insiderNoFilings).toBe(2);
    expect(r.insiderEmpty).toBe(0);
    expect(r.insiderFailed).toBe(0);
  });

  it("a real sale or purchase is ok; an Alpha Vantage empty stays n/a; failures stay n/a", async () => {
    const r = await runInsiderPass([{ id: "a", symbol: "A" }, { id: "b", symbol: "B" }, { id: "c", symbol: "C" }, { id: "d", symbol: "D" }], {
      ...fakeClock(0),
      fetchRows: async (s) =>
        s === "A" ? edgarOk([mRow("S")]) : s === "B" ? edgarOk([mRow("P")]) : s === "C" ? { ok: true, rows: [], responseKeys: ["data"], source: "alphavantage" } : { ok: false, reason: "x", responseKeys: [] },
    });
    expect(r.diagnostics.map((d) => [d.symbol, d.status, d.netSoldUsd])).toEqual([["A", "ok", 1000], ["B", "ok", -1000], ["C", "empty", null], ["D", "failed", null]]);
  });

  it("persists the zero with source edgar so it renders as '$0 (no filings)'", async () => {
    await enrichInsiderForLatestMonthlyScan({ ...fakeClock(0), fetchRows: async () => edgarOk([]), fetchOverviewFn: async () => ({ ok: false, reason: "n/a" }) });
    expect(state.rows.every((r) => r.insiderNetSoldUsd30d === 0 && r.insiderFetchedAt != null)).toBe(true);
  });
});

describe("market cap and net sold as a percent of market cap", () => {
  const sale = [{ transaction_date: new Date().toISOString().slice(0, 10), executive: "A", security_type: "Common Stock", acquisition_or_disposal: "S", shares: "1000", share_price: "10" }];

  it("enrichment stores marketCap (shares x scan close) and insiderNetSoldPctOfMarketCap", async () => {
    await enrichInsiderForLatestMonthlyScan({
      ...fakeClock(0),
      fetchRows: async () => ({ ok: true, rows: sale, responseKeys: [], source: "edgar" }),
      fetchOverviewFn: async () => ({ ok: true, sharesOutstanding: 1_000_000, reportedMarketCap: 5 }),
    });
    const r1 = state.rows[0]; // scanClose 10 -> cap 10,000,000; net sold 10,000 -> 0.1%
    expect(r1.marketCap).toBe(10_000_000);
    expect(r1.marketCapSource).toBe("shares_x_close");
    expect(r1.insiderNetSoldPctOfMarketCap).toBeCloseTo(0.1);
    expect(state.rows[1].marketCap).toBe(11_000_000);
  });

  it("falls back to the reported cap, marks failures 'unavailable' (not retried unless retryFailed), and leaves pct null", async () => {
    let calls = 0;
    const fetchOverviewFn = async (symbol: string) => (++calls, symbol === "S1" ? ({ ok: true, sharesOutstanding: null, reportedMarketCap: 2_000_000_000 } as const) : ({ ok: false, reason: "Information: rate limit" } as const));
    await enrichInsiderForLatestMonthlyScan({ ...fakeClock(0), fetchRows: async () => ({ ok: true, rows: sale, responseKeys: [], source: "edgar" }), fetchOverviewFn });
    expect(state.rows[0]).toMatchObject({ marketCap: 2_000_000_000, marketCapSource: "av_reported" });
    expect(state.rows[1]).toMatchObject({ marketCap: null, marketCapSource: "unavailable", insiderNetSoldPctOfMarketCap: null });
    const before = calls;
    await enrichInsiderForLatestMonthlyScan({ ...fakeClock(0), fetchOverviewFn });
    expect(calls).toBe(before);
    await enrichInsiderForLatestMonthlyScan({ ...fakeClock(0), retryFailed: true, fetchOverviewFn: async () => ({ ok: true, sharesOutstanding: 100, reportedMarketCap: null }) });
    expect(state.rows[1]).toMatchObject({ marketCap: 100 * 11, marketCapSource: "shares_x_close" });
    expect(state.rows[1].insiderNetSoldPctOfMarketCap).toBeCloseTo((10_000 / 1100) * 100);
  });

  it("the market-cap pass stops cleanly at the deadline", async () => {
    const clock = fakeClock(10_000);
    const r = await runMarketCapPass(
      Array.from({ length: 10 }, (_, i) => ({ id: `${i}`, symbol: `S${i}`, scanClose: 10, insiderNetSoldUsd30d: null })),
      { ...clock, deadlineMs: 45_000, fetchOverviewFn: async () => ({ ok: true, sharesOutstanding: 1, reportedMarketCap: null }) },
    );
    expect(r.marketCapAttempted).toBeGreaterThan(0);
    expect(r.marketCapSkippedByDeadline).toBe(10 - r.marketCapAttempted);
  });
});
