import { afterEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    beta = { messages: { create } };
  },
}));
vi.mock("@/lib/agents/claudeFailures", () => ({
  MISSING_KEY_REASON: "missing",
  recordClaudeError: vi.fn(),
  recordClaudeFailure: vi.fn(),
}));

const { generateNewsSentimentNotes } = await import("@/lib/agents/newsSentiment");

const note = (n: string) => ({ content: [{ type: "text", text: JSON.stringify({ noteType: "tailwind", note: n, sourceHint: "beat" }) }] });

afterEach(() => {
  create.mockReset();
  delete process.env.APP_ANTHROPIC_API_KEY;
});

describe("generateNewsSentimentNotes budget", () => {
  it("passes a per-call timeout and no retries", async () => {
    process.env.APP_ANTHROPIC_API_KEY = "k";
    create.mockResolvedValue(note("ok"));
    const notes = await generateNewsSentimentNotes([{ symbol: "AAA", name: "Aaa" }], 60_000);
    expect(notes).toHaveLength(1);
    const opts = create.mock.calls[0][1] as { timeout: number; maxRetries: number };
    expect(opts.maxRetries).toBe(0);
    expect(opts.timeout).toBeLessThanOrEqual(45_000);
  });

  it("keeps finished notes and skips candidates once the budget is spent", async () => {
    process.env.APP_ANTHROPIC_API_KEY = "k";
    create.mockResolvedValue(note("ok"));
    // A budget below the minimum call time means nothing new is started.
    const none = await generateNewsSentimentNotes([{ symbol: "AAA", name: "Aaa" }], 5_000);
    expect(none).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("drops a failed candidate without failing the pass", async () => {
    process.env.APP_ANTHROPIC_API_KEY = "k";
    create.mockRejectedValueOnce(new Error("timeout")).mockResolvedValue(note("ok"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const notes = await generateNewsSentimentNotes(
      [{ symbol: "AAA", name: "Aaa" }, { symbol: "BBB", name: "Bbb" }],
      60_000,
    );
    expect(notes).toHaveLength(1);
  });
});
