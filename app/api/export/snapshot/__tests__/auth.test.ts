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

  it("rejects a forged session cookie", async () => {
    const res = await middleware(
      new NextRequest("http://localhost/api/export/snapshot", { headers: { cookie: "session=forged.token.value" } }),
    );
    expect(res.status).toBe(401);
  });
});
