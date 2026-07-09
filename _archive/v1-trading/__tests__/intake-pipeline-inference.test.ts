import { describe, it, expect } from "vitest";
import { inferFileHintsFromText } from "@/lib/agents/intake-pipeline";

// ─── Acceptance test ─────────────────────────────────────────────────

describe("inferFileHintsFromText — acceptance", () => {
  it("infers agent infra files for 'last-mile autonomous agent execution'", () => {
    const hints = inferFileHintsFromText(
      "Fix last-mile autonomous agent execution",
      "Agents are READY but not burning down tasks.",
      "BUGFIX",
    );
    expect(hints).toContain("app/api/agents/execute/route.ts");
    expect(hints).toContain("app/api/agents/state/route.ts");
    expect(hints).toContain("app/api/agents/queue/route.ts");
    expect(hints.some((h) => h.startsWith("lib/agents/"))).toBe(true);
  });
});

// ─── Keyword cluster matching ─────────────────────────────────────────

describe("inferFileHintsFromText — keyword clusters", () => {
  it("matches 'autonomous' keyword → full agent suite", () => {
    const hints = inferFileHintsFromText(
      "Autonomous task runner fix",
      "The autonomous runner is broken.",
      "BUGFIX",
    );
    expect(hints).toContain("app/api/agents/execute/route.ts");
    expect(hints).toContain("app/api/agents/state/route.ts");
    expect(hints).toContain("app/api/agents/queue/route.ts");
  });

  it("matches 'executor' keyword → execute route + executor file", () => {
    const hints = inferFileHintsFromText(
      "Fix the executor crash",
      "The manual task executor is crashing.",
      "BUGFIX",
    );
    expect(hints).toContain("app/api/agents/execute/route.ts");
    expect(hints).toContain("lib/agents/manual-task-executor.ts");
  });

  it("matches 'burn down' / 'burning down' keyword", () => {
    const hints = inferFileHintsFromText(
      "Tasks not burning down",
      "Agents are READY but not burning down tasks.",
      "BUGFIX",
    );
    expect(hints).toContain("app/api/agents/execute/route.ts");
    expect(hints).toContain("lib/agents/manual-task-executor.ts");
  });

  it("matches 'intake' keyword → intake pipeline files", () => {
    const hints = inferFileHintsFromText(
      "Fix intake normalization bug",
      "Chat intake is rejecting valid payloads.",
      "BUGFIX",
    );
    expect(hints).toContain("app/api/agents/chat-intake-public/route.ts");
    expect(hints).toContain("lib/agents/intake-pipeline.ts");
    expect(hints).toContain("lib/agents/task-normalizer.ts");
  });

  it("matches 'scoring' keyword → scoring files", () => {
    const hints = inferFileHintsFromText(
      "Fix scoring weights",
      "The scoring weights are miscalibrated.",
      "SCORING",
    );
    expect(hints).toContain("lib/scoring/weights.ts");
    expect(hints).toContain("lib/scoring/thresholds.ts");
  });

  it("matches 'incident' keyword → incidents files", () => {
    const hints = inferFileHintsFromText(
      "Fix incident route",
      "Agent incident route is returning 500.",
      "BUGFIX",
    );
    expect(hints).toContain("app/api/agents/incidents/route.ts");
    expect(hints).toContain("lib/agents/incidents.ts");
  });

  it("matches 'agent' fallback keyword → core agent files", () => {
    const hints = inferFileHintsFromText(
      "Agent bug fix",
      "Something is wrong with the agent loop.",
      "BUGFIX",
    );
    expect(hints.some((h) => h.startsWith("lib/agents/"))).toBe(true);
  });

  it("returns empty array for completely unrelated content", () => {
    const hints = inferFileHintsFromText(
      "Update README",
      "Just updating documentation.",
      "OTHER",
    );
    expect(hints).toEqual([]);
  });
});

// ─── Trading files blocked ───────────────────────────────────────────

describe("inferFileHintsFromText — trading block", () => {
  it("blocks inference when title mentions 'broker'", () => {
    const hints = inferFileHintsFromText(
      "Fix broker connection",
      "Broker API keeps returning 400.",
      "BUGFIX",
    );
    expect(hints).toEqual([]);
  });

  it("blocks inference when description mentions 'alpaca'", () => {
    const hints = inferFileHintsFromText(
      "Order routing bug",
      "The alpaca order routing is failing.",
      "BUGFIX",
    );
    expect(hints).toEqual([]);
  });

  it("blocks inference when text mentions 'auto-entry'", () => {
    const hints = inferFileHintsFromText(
      "Fix auto-entry trigger",
      "Auto-entry signals are not firing.",
      "AUTO_ENTRY",
    );
    expect(hints).toEqual([]);
  });

  it("blocks inference when text mentions 'order'", () => {
    const hints = inferFileHintsFromText(
      "Fix live trading order fill",
      "Order fill not being recorded.",
      "BUGFIX",
    );
    expect(hints).toEqual([]);
  });
});

// ─── Deduplication ───────────────────────────────────────────────────

describe("inferFileHintsFromText — deduplication", () => {
  it("does not return duplicate hints when multiple rules match overlapping files", () => {
    const hints = inferFileHintsFromText(
      "Fix autonomous agent execution and executor failure",
      "The autonomous runner and agent executor are both broken.",
      "BUGFIX",
    );
    const unique = new Set(hints);
    expect(hints.length).toBe(unique.size);
  });
});
