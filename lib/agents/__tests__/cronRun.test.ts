import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ created: [] as Array<Record<string, unknown>>, recorded: [] as Array<Record<string, unknown>> }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    scanHealth: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => void h.created.push(data)),
      findMany: vi.fn(async () => []),
    },
  },
}));
vi.mock("@/lib/agents/scanHealth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agents/scanHealth")>()),
  recordScanHealth: vi.fn(async (r: Record<string, unknown>) => void h.recorded.push(r)),
}));

const { runCron, summarizeCronRuns, cronHttpStatus, cronStatus } = await import("@/lib/agents/cronRun");

const req = (url = "http://localhost/api/cron/weekly-brief") => new NextRequest(url, { headers: { "user-agent": "vercel-cron/1.0" } });

beforeEach(() => {
  h.created.length = 0;
  h.recorded.length = 0;
});

describe("runCron", () => {
  it("writes a start row before the handler runs, then a HEALTHY finish row, and returns 200", async () => {
    let startedBeforeHandler = false;
    const res = await runCron("weekly-brief", req(), async () => {
      startedBeforeHandler = h.created.length === 1;
      return { outcome: "ok", body: { brief: "created" } };
    });
    expect(startedBeforeHandler).toBe(true);
    expect(h.created[0]).toMatchObject({ kind: "CRON:weekly-brief", metrics: expect.objectContaining({ phase: "start", userAgent: "vercel-cron/1.0" }) });
    expect(h.recorded[0]).toMatchObject({ kind: "CRON:weekly-brief", status: "HEALTHY", metrics: expect.objectContaining({ phase: "finish", outcome: "ok" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "ok", brief: "created" });
  });

  it("a skip is a non-2xx (422) recorded as DEGRADED with its reason", async () => {
    const res = await runCron("weekly-brief", req(), async () => ({ outcome: "skipped", reason: "No candidate items" }));
    expect(res.status).toBe(422);
    expect(h.recorded[0]).toMatchObject({ status: "DEGRADED", reasons: ["No candidate items"] });
    expect(await res.json()).toMatchObject({ outcome: "skipped", reason: "No candidate items" });
  });

  it("a throw becomes a recorded FAILED run and a 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await runCron("news-sentiment", req(), async () => {
      throw new Error("boom");
    });
    expect(res.status).toBe(500);
    expect(h.recorded[0]).toMatchObject({ kind: "CRON:news-sentiment", status: "FAILED", reasons: ["boom"] });
  });

  it("an ok run with warnings is DEGRADED but still 200; dryRun is tagged", async () => {
    const res = await runCron("refresh-candidate-universe", req("http://localhost/api/cron/refresh-candidate-universe?dryRun=1"), async () => ({ outcome: "ok", warnings: ["news step timed out"] }));
    expect(res.status).toBe(200);
    expect(h.recorded[0]).toMatchObject({ status: "DEGRADED", reasons: ["news step timed out"], metrics: expect.objectContaining({ dryRun: true }) });
    expect(h.created[0].metrics).toMatchObject({ dryRun: true });
  });

  it("status mapping", () => {
    expect([cronHttpStatus("ok"), cronHttpStatus("skipped"), cronHttpStatus("failed")]).toEqual([200, 422, 500]);
    expect(cronStatus({ outcome: "ok" })).toBe("HEALTHY");
  });
});

describe("summarizeCronRuns", () => {
  const row = (kind: string, phase: string, outcome: string | null, at: string) => ({ kind, status: "HEALTHY" as const, reasons: ["r"], phase, outcome, createdAt: new Date(at) });
  it("newest row per cron; a start with no finish after it is flagged", () => {
    const latest = summarizeCronRuns([
      row("CRON:weekly-brief", "start", null, "2026-10-11T22:30:00Z"),
      row("CRON:weekly-brief", "finish", "ok", "2026-10-04T22:31:00Z"),
      row("CRON:db-keepalive", "finish", "failed", "2026-10-10T21:58:00Z"),
    ]);
    expect(latest.find((c) => c.name === "weekly-brief")!.state).toBe("started-no-finish");
    expect(latest.find((c) => c.name === "db-keepalive")!.state).toBe("failed");
    expect(latest).toHaveLength(2);
  });
});
