import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; symbol: string; rank: number; batchTag: string; insiderFetchedAt: Date | null; insiderNetSoldUsd30d: number | null };
const state = vi.hoisted(() => ({ rows: [] as Row[] }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    candidateRecommendationLog: {
      findFirst: vi.fn(async () => (state.rows[0] ? { batchTag: state.rows[0].batchTag } : null)),
      findMany: vi.fn(async ({ where }: { where: { insiderFetchedAt?: null; OR?: unknown[] } }) =>
        state.rows
          .filter((r) => (where.OR ? r.insiderFetchedAt == null || r.insiderNetSoldUsd30d == null : r.insiderFetchedAt == null))
          .map((r) => ({ id: r.id, symbol: r.symbol })),
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        Object.assign(state.rows.find((r) => r.id === where.id)!, data);
      }),
    },
  },
}));

const { runInsiderPass, enrichInsiderForLatestMonthlyScan, INSIDER_PASS_DEADLINE_MS } = await import("@/lib/agents/insiderEnrichment");

const sale = [{ transaction_date: new Date().toISOString().slice(0, 10), executive: "A", security_type: "Ordinary Shares", acquisition_or_disposal: "D", shares: "10", share_price: "5" }];

function seed(n: number) {
  state.rows = Array.from({ length: n }, (_, i) => ({ id: `r${i + 1}`, symbol: `S${i + 1}`, rank: i + 1, batchTag: "monthly-2026-11", insiderFetchedAt: null, insiderNetSoldUsd30d: null }));
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
    expect(result.insiderSucceeded).toBe(1);
    expect(result.deadlineHit).toBe(false);
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
