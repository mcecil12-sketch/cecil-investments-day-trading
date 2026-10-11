import { describe, expect, it, vi } from "vitest";
import { captureClaudeFailures, describeClaudeError, recordClaudeFailure } from "@/lib/agents/claudeFailures";

describe("claudeFailures", () => {
  it("captures failures recorded inside the scope, even across awaits, and returns thrown errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await captureClaudeFailures(async () => {
      await Promise.resolve();
      recordClaudeFailure("CIO brief", "missing key");
      throw new Error("x");
    });
    expect(out.failures).toEqual([{ source: "CIO brief", reason: "missing key" }]);
    expect((out.error as Error).message).toBe("x");
  });

  it("is a no-op outside a scope", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => recordClaudeFailure("x", "y")).not.toThrow();
  });

  it("calls out billing/credit errors explicitly", () => {
    const err = Object.assign(new Error("Your credit balance is too low to access the Anthropic API."), { status: 400 });
    expect(describeClaudeError(err)).toMatch(/^BILLING\/CREDIT/);
    expect(describeClaudeError(Object.assign(new Error("nope"), { status: 429 }))).toMatch(/^RATE LIMITED/);
    expect(describeClaudeError(Object.assign(new Error("bad key"), { status: 401 }))).toMatch(/^AUTH/);
  });
});
