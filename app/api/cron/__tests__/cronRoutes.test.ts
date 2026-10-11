import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  brief: { outcome: "created", weekOf: "2026-10-05", warnings: [] as string[] } as Record<string, unknown>,
  calls: [] as string[],
}));

vi.mock("@/lib/agents/cronRun", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agents/cronRun")>();
  // Real runCron semantics, minus the DB: just run the handler and map the outcome.
  return {
    ...actual,
    runCron: vi.fn(async (_name: string, _req: unknown, handler: () => Promise<{ outcome: "ok" | "failed" | "skipped"; reason?: string; body?: object }>) => {
      const { NextResponse } = await import("next/server");
      const r = await handler();
      return NextResponse.json({ outcome: r.outcome, reason: r.reason, ...(r.body ?? {}) }, { status: actual.cronHttpStatus(r.outcome) });
    }),
  };
});
vi.mock("@/lib/agents/runner", () => ({
  synthesizeWeeklyBrief: vi.fn(async () => h.brief),
  runAndPersistCandidateUniverseRefresh: vi.fn(async () => (h.calls.push("universe"), { status: "COMPLETE", runId: "u1" })),
  runAndPersistMonthlyScan: vi.fn(async () => (h.calls.push("monthlyScan"), { status: "COMPLETE" })),
  runAndPersistEarningsHistoryRefresh: vi.fn(async () => ({ status: "COMPLETE" })),
  runAndPersistSentimentRefresh: vi.fn(async () => ({ status: "FAILED", error: "av down" })),
}));
vi.mock("@/lib/notifications/weeklyBrief", () => ({ sendWeeklyBriefNotification: vi.fn(async () => ({ sent: false, reason: "not configured" })) }));
vi.mock("@/lib/agents/monthlyScanDryRun", () => ({ runMonthlyScanDryRun: vi.fn(async () => (h.calls.push("dryRun"), { totalMs: 1234, percentOfMaxDuration: 0.5, counts: { ranked: 30 } })) }));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn((p: Promise<unknown>) => void p) }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

const weeklyBrief = await import("@/app/api/cron/weekly-brief/route");
const universe = await import("@/app/api/cron/refresh-candidate-universe/route");
const sentiment = await import("@/app/api/cron/news-sentiment/route");

const cronReq = (path: string, headers: Record<string, string> = {}) => new NextRequest(`http://localhost${path}`, { headers: { "user-agent": "vercel-cron/1.0", ...headers } });

beforeEach(() => {
  h.calls.length = 0;
  h.brief = { outcome: "created", weekOf: "2026-10-05", warnings: [] };
  delete process.env.CRON_SECRET;
});
afterEach(() => void delete process.env.CRON_SECRET);

describe("weekly-brief cron", () => {
  it("200 when the brief is written", async () => {
    const res = await weeklyBrief.GET(cronReq("/api/cron/weekly-brief"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "ok", brief: "created", weekOf: "2026-10-05" });
  });

  it("a skipped brief is 422 with the reason — never a quiet 200", async () => {
    h.brief = { outcome: "skipped", reason: "No candidate items", warnings: [] };
    const res = await weeklyBrief.GET(cronReq("/api/cron/weekly-brief"));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ outcome: "skipped", reason: "No candidate items" });
  });

  it("rejects a wrong or missing bearer when CRON_SECRET is set (401), accepts the right one", async () => {
    process.env.CRON_SECRET = "s3cret";
    expect((await weeklyBrief.GET(cronReq("/api/cron/weekly-brief"))).status).toBe(401);
    expect((await weeklyBrief.GET(cronReq("/api/cron/weekly-brief", { authorization: "Bearer nope" }))).status).toBe(401);
    expect((await weeklyBrief.GET(cronReq("/api/cron/weekly-brief", { authorization: "Bearer s3cret" }))).status).toBe(200);
  });
});

describe("refresh-candidate-universe cron (monthly path)", () => {
  it("?dryRun=1 with a valid cron bearer runs only the dry-run pipeline and returns the report — no universe refresh, no logged scan", async () => {
    process.env.CRON_SECRET = "s3cret";
    const res = await universe.GET(cronReq("/api/cron/refresh-candidate-universe?dryRun=1", { authorization: "Bearer s3cret" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ dryRun: true, report: { totalMs: 1234 } });
    expect(h.calls).toEqual(["dryRun"]);
  });

  it("without the flag it refreshes the universe and schedules the real monthly scan", async () => {
    const res = await universe.GET(cronReq("/api/cron/refresh-candidate-universe"));
    expect(res.status).toBe(200);
    expect(h.calls).toEqual(["universe", "monthlyScan"]);
  });

  it("a dry run is still behind the cron secret", async () => {
    process.env.CRON_SECRET = "s3cret";
    expect((await universe.GET(cronReq("/api/cron/refresh-candidate-universe?dryRun=1"))).status).toBe(401);
    expect(h.calls).toEqual([]);
  });
});

describe("news-sentiment cron", () => {
  it("a failed refresh is a 500, not a 200", async () => {
    const res = await sentiment.GET(cronReq("/api/cron/news-sentiment"));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ outcome: "failed", reason: "av down" });
  });
});
