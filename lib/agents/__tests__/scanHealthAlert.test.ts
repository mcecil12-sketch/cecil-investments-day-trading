import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: { scanHealth: { create: vi.fn(), findFirst: vi.fn() } } }));

const { maybeSendHealthAlert, healthAlertText } = await import("@/lib/agents/scanHealth");

const ENV_KEYS = ["PUSHOVER_USER_KEY", "PUSHOVER_API_TOKEN", "PUSHOVER_APP_TOKEN", "RESEND_API_KEY", "ALERT_EMAIL"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

const degraded = { kind: "WEEKLY_BRIEF" as const, status: "DEGRADED" as const, reasons: ["News sentiment notes timed out after 90s"], metrics: {} };

describe("maybeSendHealthAlert", () => {
  it("pushes via Pushover on DEGRADED when the keys are set", async () => {
    process.env.PUSHOVER_USER_KEY = "u";
    process.env.PUSHOVER_APP_TOKEN = "t";
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await maybeSendHealthAlert(degraded as never)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("pushover.net");
    const body = new URLSearchParams(init.body as URLSearchParams);
    expect(body.get("title")).toBe("[Cecil] WEEKLY_BRIEF DEGRADED");
    expect(body.get("priority")).toBe("0");
  });

  it("uses high priority for FAILED", async () => {
    process.env.PUSHOVER_USER_KEY = "u";
    process.env.PUSHOVER_API_TOKEN = "t";
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await maybeSendHealthAlert({ ...degraded, status: "FAILED" } as never);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URLSearchParams(init.body as URLSearchParams).get("priority")).toBe("1");
  });

  it("stays silent on HEALTHY and when nothing is configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await maybeSendHealthAlert({ ...degraded, status: "HEALTHY" } as never)).toBe(false);
    expect(await maybeSendHealthAlert(degraded as never)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when the push request fails", async () => {
    process.env.PUSHOVER_USER_KEY = "u";
    process.env.PUSHOVER_APP_TOKEN = "t";
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    expect(await maybeSendHealthAlert(degraded as never)).toBe(false);
  });
});

describe("healthAlertText", () => {
  it("caps the message at Pushover's 1024-character limit", () => {
    const { message } = healthAlertText({ ...degraded, reasons: ["x".repeat(2000)] } as never);
    expect(message.length).toBe(1024);
  });
});
