import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAuth: vi.fn(async () => ({ ok: false })),
}));

import { requireAuth } from "@/lib/auth";
import {
  checkAgentCronAuth,
  checkAgentReadAuth,
  unauthorizedAgentResponse,
} from "../auth";

describe("agent auth helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CRON_TOKEN;
    delete process.env.CRON_SECRET;
  });

  it("accepts a valid x-cron-token via CRON_TOKEN", () => {
    process.env.CRON_TOKEN = "test-cron-token";

    const result = checkAgentCronAuth(
      new Request("http://localhost/api/agents/state", {
        headers: { "x-cron-token": "test-cron-token" },
      })
    );

    expect(result).toEqual({ ok: true });
  });

  it("falls back to CRON_SECRET when CRON_TOKEN is unset", () => {
    process.env.CRON_SECRET = "test-cron-secret";

    const result = checkAgentCronAuth(
      new Request("http://localhost/api/agents/state", {
        headers: { "x-cron-token": "test-cron-secret" },
      })
    );

    expect(result).toEqual({ ok: true });
  });

  it("allows authenticated app reads when cron auth is absent", async () => {
    vi.mocked(requireAuth).mockResolvedValue({ ok: true });

    const result = await checkAgentReadAuth(
      new Request("http://localhost/api/agents/state")
    );

    expect(result).toEqual({ ok: true, authMode: "app_pin" });
  });

  it("prefers cron auth on reads without calling requireAuth", async () => {
    process.env.CRON_TOKEN = "test-cron-token";

    const result = await checkAgentReadAuth(
      new Request("http://localhost/api/agents/state", {
        headers: { "x-cron-token": "test-cron-token" },
      })
    );

    expect(result).toEqual({ ok: true, authMode: "cron_token" });
    expect(vi.mocked(requireAuth)).not.toHaveBeenCalled();
  });

  it("returns structured 401 JSON", async () => {
    const response = unauthorizedAgentResponse("unauthorized");
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body).toEqual({
      ok: false,
      error: "unauthorized",
      message: "Missing or invalid x-cron-token",
    });
  });
});