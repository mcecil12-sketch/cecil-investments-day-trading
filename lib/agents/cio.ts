import Anthropic from "@anthropic-ai/sdk";

export type CioItemSource =
  | "risk_critical"
  | "risk_watch"
  | "opportunity_cost"
  | "relative_strength_top"
  | "relative_strength_candidate"
  | "relative_strength_underperformer"
  | "sector_flag"
  | "sector_top";

export interface CioCandidateItem {
  /** Stable identifier so Claude can reference an item without re-typing its content — never shown to the user. */
  key: string;
  source: CioItemSource;
  agentRunId: string;
  action: string;
  rationale: string;
  expectedImpact: string | null;
  accountId: string | null;
}

export interface CioBrief {
  summary: string;
  orderedItems: CioCandidateItem[];
}

const SYSTEM_PROMPT = `You are the CIO of a household investment portfolio, writing the weekly brief that the household will read at a glance. You're given candidate findings from three portfolio agents (Risk Manager, Relative Strength, Sector Rotation) as JSON. Each candidate has a "source" tag showing which agent raised it.

Do two things:
1. Write a 2-4 sentence executive summary in plain English — no jargon dump, no restating every item. Lead with whatever is most urgent or most likely to matter to the household this week (critical risk flags first, if any), then the highest-conviction opportunity, then anything else worth a sentence.
2. Reorder the candidates by true priority — most urgent and highest-impact first — and trim to at most 8 total. Critical risk flags always outrank everything else. Drop redundant or low-signal items rather than padding the list.

Only use the "key" values you were given — never invent a new key or alter an item's underlying facts.`;

const BRIEF_TOOL: Anthropic.Tool = {
  name: "submit_cio_brief",
  description: "Submit the synthesized weekly CIO brief.",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "2-4 sentence natural-language executive summary for the household's weekly investment brief.",
      },
      orderedKeys: {
        type: "array",
        items: { type: "string" },
        description: "Candidate 'key' values, reordered by priority (most urgent/impactful first) and trimmed to at most 8. Every value must be one of the candidate keys provided.",
      },
    },
    required: ["summary", "orderedKeys"],
  },
};

function fallbackSummary(candidates: CioCandidateItem[]): string {
  if (candidates.length === 0) {
    return "No new signals from Risk Manager, Relative Strength, or Sector Rotation this week.";
  }
  const sources = [...new Set(candidates.map((c) => c.source))];
  return `${candidates.length} item(s) surfaced this week across ${sources.length} agent(s). Automatic prioritization is unavailable right now — items below are in raw agent order.`;
}

/**
 * Sends this week's candidate findings to Claude for natural-language
 * synthesis and priority ranking. Falls back to the raw candidate order (no
 * throw) if ANTHROPIC_API_KEY is missing or the API call fails, since a CIO
 * synthesis hiccup shouldn't block the underlying agent runs from persisting.
 */
export async function synthesizeCioBrief(candidates: CioCandidateItem[]): Promise<CioBrief> {
  if (candidates.length === 0) {
    return { summary: fallbackSummary(candidates), orderedItems: [] };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { summary: fallbackSummary(candidates), orderedItems: candidates.slice(0, 8) };
  }

  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 1536,
    system: SYSTEM_PROMPT,
    tools: [BRIEF_TOOL],
    tool_choice: { type: "tool", name: "submit_cio_brief" },
    messages: [
      {
        role: "user",
        content: `This week's candidate items from the portfolio agents:\n\n${JSON.stringify(
          candidates.map(({ key, source, action, rationale, expectedImpact }) => ({
            key,
            source,
            action,
            rationale,
            expectedImpact,
          })),
          null,
          2,
        )}`,
      },
    ],
  });

  const toolUse = message.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
  if (!toolUse) {
    throw new Error("Claude didn't return a structured CIO brief");
  }

  const input = toolUse.input as { summary: string; orderedKeys: string[] };
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const orderedItems = input.orderedKeys
    .map((k) => byKey.get(k))
    .filter((c): c is CioCandidateItem => Boolean(c));

  return {
    summary: input.summary,
    orderedItems: orderedItems.length > 0 ? orderedItems : candidates.slice(0, 8),
  };
}
