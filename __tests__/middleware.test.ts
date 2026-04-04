import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";

describe("middleware machine API allowlist", () => {
  it("lets /api/agents requests reach route-level auth without cookie auth", () => {
    const response = middleware(
      new NextRequest("http://localhost/api/agents/state")
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("still returns structured 401 JSON for unrelated protected API paths", async () => {
    const response = middleware(
      new NextRequest("http://localhost/api/internal-only")
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "unauthorized",
      message: "Missing authentication credentials",
    });
  });
});