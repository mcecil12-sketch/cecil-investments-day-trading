import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, verifySessionToken } from "@/lib/auth/session";

const ORIGINAL_SECRET = process.env.SESSION_SECRET;

beforeEach(() => {
  process.env.SESSION_SECRET = "test-secret-do-not-use-in-prod";
});

afterEach(() => {
  process.env.SESSION_SECRET = ORIGINAL_SECRET;
  vi.useRealTimers();
});

describe("createSessionToken / verifySessionToken", () => {
  it("a freshly created token verifies as valid", async () => {
    const token = await createSessionToken();
    expect(await verifySessionToken(token)).toBe(true);
  });

  it("rejects a missing token", async () => {
    expect(await verifySessionToken(undefined)).toBe(false);
    expect(await verifySessionToken(null)).toBe(false);
    expect(await verifySessionToken("")).toBe(false);
  });

  it("rejects a malformed token", async () => {
    expect(await verifySessionToken("not-a-real-token")).toBe(false);
    expect(await verifySessionToken("only.two.parts.extra")).toBe(false);
  });

  it("rejects a token whose signature has been tampered with", async () => {
    const token = await createSessionToken();
    const [payload, signature] = token.split(".");
    const flippedChar = signature[0] === "a" ? "b" : "a";
    const tampered = `${payload}.${flippedChar}${signature.slice(1)}`;
    expect(await verifySessionToken(tampered)).toBe(false);
  });

  it("rejects a token whose payload has been tampered with", async () => {
    const token = await createSessionToken();
    const [payload, signature] = token.split(".");
    const flippedChar = payload[0] === "a" ? "b" : "a";
    const tampered = `${flippedChar}${payload.slice(1)}.${signature}`;
    expect(await verifySessionToken(tampered)).toBe(false);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await createSessionToken();
    process.env.SESSION_SECRET = "a-completely-different-secret";
    expect(await verifySessionToken(token)).toBe(false);
  });

  it("rejects an expired token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const token = await createSessionToken();
    expect(await verifySessionToken(token)).toBe(true);

    vi.setSystemTime(new Date("2026-03-01T00:00:00Z")); // well past the 30-day maxAge
    expect(await verifySessionToken(token)).toBe(false);
  });

  it("throws when neither SESSION_SECRET nor NEXTAUTH_SECRET is configured", async () => {
    delete process.env.SESSION_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    await expect(createSessionToken()).rejects.toThrow(/SESSION_SECRET/);
  });
});
