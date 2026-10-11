import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

beforeEach(() => {
  process.env.SESSION_SECRET = "test-secret-do-not-use-in-prod";
});

async function locked(path: string) {
  const res = await middleware(new NextRequest(`http://localhost${path}`));
  return { status: res.status, body: await res.json() };
}

describe("PIN gate on /api/export/snapshot", () => {
  it("rejects an unauthenticated request exactly like other protected API routes", async () => {
    const snapshot = await locked("/api/export/snapshot");
    const other = await locked("/api/benchmark");
    expect(snapshot.status).toBe(401);
    expect(snapshot).toEqual(other);
  });

  it.each(["/api/agents/scan-health", "/api/agents/monthly-scan", "/api/agents/monthly-scan/enrich-insider"])(
    "also locks %s",
    async (path) => {
      expect((await locked(path)).status).toBe(401);
    },
  );

  it.each(["db-keepalive", "earnings-estimates", "news-sentiment", "refresh-candidate-universe", "weekly-brief"])(
    "lets /api/cron/%s through the PIN gate without a session cookie (each route enforces CRON_SECRET itself)",
    async (name) => {
      const res = await middleware(new NextRequest(`http://localhost/api/cron/${name}`, { headers: { "user-agent": "vercel-cron/1.0" } }));
      expect(res.status).toBe(200);
      expect(res.headers.get("x-middleware-next")).toBe("1");
    },
  );

  it("rejects a forged session cookie", async () => {
    const res = await middleware(
      new NextRequest("http://localhost/api/export/snapshot", { headers: { cookie: "session=forged.token.value" } }),
    );
    expect(res.status).toBe(401);
  });
});
