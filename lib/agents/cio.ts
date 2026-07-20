import Anthropic from "@anthropic-ai/sdk";
import type { TaxableAnalysisContext } from "@/lib/agents/taxableAnalysis";

export type CioItemSource =
  | "risk_critical"
  | "risk_watch"
  | "opportunity_cost"
  | "relative_strength_top"
  | "relative_strength_candidate"
  | "relative_strength_underperformer"
  | "sector_flag"
  | "sector_top"
  | "candidate_new";

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

export interface CioTrimCandidate {
  symbol: string;
  rationale: string;
  estimatedGain: string;
  taxImpact: string;
}

export interface CioLeadingSectorGap {
  sector: string;
  rationale: string;
}

export interface CioMomentumAdd {
  symbol: string;
  rationale: string;
}

export interface CioTaxableOpportunities {
  trimCandidates: CioTrimCandidate[];
  leadingSectorsNoExposure: CioLeadingSectorGap[];
  momentumAdds: CioMomentumAdd[];
}

export interface CioBrief {
  summary: string;
  orderedItems: CioCandidateItem[];
  taxableOpportunities: CioTaxableOpportunities | null;
}

const SYSTEM_PROMPT = `You are the CIO of a household investment portfolio, writing the weekly brief that the household will read at a glance. You're given candidate findings from four portfolio agents (Risk Manager, Relative Strength, Sector Rotation, Candidate Scanner) as JSON. Each candidate has a "source" tag showing which agent raised it. Sources starting with "risk_", "relative_strength_", and "sector_" all concern the portfolio's existing holdings — HOLD, TRIM, or watch decisions. Sources tagged "candidate_new" are stocks/ETFs the household does not currently own — ADD decisions.

The portfolio has five taxable Fidelity accounts (Cecil Investments, Grandma Potter Gift, Personal Investments, For Kennedy, Gifts and Trips) holding primarily FSELX, FSPGX, and FXAIX. These accounts have full flexibility for individual stocks and Fidelity funds. The owner has approximately $150k in capital gains capacity this year with minimal tax impact. Always include specific taxable account recommendations alongside retirement account recommendations.

Do three things:
1. Write a 2-4 sentence executive summary in plain English — no jargon dump, no restating every item. Lead with whatever is most urgent or most likely to matter to the household this week (critical risk flags first, if any). If there's no critical risk flag, and a "candidate_new" item is the single highest-conviction opportunity in the list, lead with that new candidate by name instead of an existing-holdings item — new-opportunity items are the freshest signal and should get top billing when nothing is on fire. Then cover anything else worth a sentence, explicitly distinguishing existing-position actions (HOLD/TRIM) from new-candidate actions (ADD) in your phrasing rather than blurring them together.
2. Reorder the candidates by true priority — most urgent and highest-impact first — and trim to at most 8 total. Critical risk flags always outrank everything else. Drop redundant or low-signal items rather than padding the list. Preserve each item's action text exactly as given (it already reads as "ADD X — new candidate" for new opportunities vs. "Hold/Review/Watch/Reduce X" for existing positions) — never rewrite an item's action or blur an ADD into a HOLD/TRIM or vice versa.
3. Using the taxable account data provided (positions with cost basis and gain/loss, sector exposure, and the FSELX position's own relative-strength read), produce a Taxable Account Opportunities analysis:
   - Review FSELX concentration across all taxable accounts combined, and flag if the semiconductor sector has weakened materially based on its relative-strength score and momentum.
   - Identify any taxable position worth trimming given the $150k capital gains capacity — include the estimated dollar gain and a plain-English note on the tax impact. Leave trimCandidates empty if nothing is worth trimming.
   - Call out sectors that are leading (top-ranked by the Sector Rotation agent) but have zero current taxable exposure — candidates for new taxable capital.
   - Call out any position with strong momentum (from the Relative Strength data) worth adding to with new taxable capital.

Only use the "key" values you were given for orderedKeys — never invent a new key or alter an item's underlying facts. Base every taxable figure strictly on the data provided — never invent dollar amounts.`;

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
      taxableOpportunities: {
        type: "object",
        description: "Taxable Account Opportunities analysis. Omit entirely if no taxable account data was provided.",
        properties: {
          trimCandidates: {
            type: "array",
            description: "Taxable positions worth trimming given the $150k capital gains capacity. Empty array if none.",
            items: {
              type: "object",
              properties: {
                symbol: { type: "string" },
                rationale: { type: "string" },
                estimatedGain: { type: "string", description: "Estimated dollar gain if trimmed, e.g. \"~$12,400\"." },
                taxImpact: { type: "string", description: "Plain-English note on the tax impact of trimming this position." },
              },
              required: ["symbol", "rationale", "estimatedGain", "taxImpact"],
            },
          },
          leadingSectorsNoExposure: {
            type: "array",
            description: "Top-ranked sectors from Sector Rotation with zero current taxable exposure. Empty array if none.",
            items: {
              type: "object",
              properties: {
                sector: { type: "string" },
                rationale: { type: "string" },
              },
              required: ["sector", "rationale"],
            },
          },
          momentumAdds: {
            type: "array",
            description: "Positions with strong momentum worth adding to with new taxable capital. Empty array if none.",
            items: {
              type: "object",
              properties: {
                symbol: { type: "string" },
                rationale: { type: "string" },
              },
              required: ["symbol", "rationale"],
            },
          },
        },
        required: ["trimCandidates", "leadingSectorsNoExposure", "momentumAdds"],
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

function taxableContextPrompt(context: TaxableAnalysisContext): string {
  return `Taxable account data (five Fidelity taxable accounts combined):\n\n${JSON.stringify(
    {
      totalTaxableValue: context.totalTaxableValue,
      capitalGainsCapacity: context.capitalGainsCapacity,
      fselxConcentrationPct: context.fselxConcentrationPct,
      positions: context.positions.map((p) => ({
        symbol: p.symbol,
        name: p.name,
        totalValue: p.totalValue,
        totalCostBasis: p.totalCostBasis,
        gainLoss: p.gainLoss,
        gainLossPct: p.gainLossPct,
        percentOfTaxablePortfolio: p.percentOfTaxablePortfolio,
      })),
      sectorExposure: context.sectorExposure,
      leadingSectorsWithZeroExposure: context.leadingSectorsWithZeroExposure,
      fselxRelativeStrength: context.fselxMomentum
        ? {
            score: context.fselxMomentum.score,
            relativeScore: context.fselxMomentum.relativeScore,
            momentum: context.fselxMomentum.momentum,
          }
        : null,
      momentumLeaders: context.momentumLeaders.map((m) => ({
        symbol: m.symbol,
        score: m.score,
        relativeScore: m.relativeScore,
        momentum: m.momentum,
      })),
    },
    null,
    2,
  )}`;
}

/**
 * Sends this week's candidate findings (and, when available, taxable account
 * data) to Claude for natural-language synthesis, priority ranking, and a
 * Taxable Account Opportunities analysis. Falls back to the raw candidate
 * order (no throw, no taxable section) if ANTHROPIC_API_KEY is missing or the
 * API call fails, since a CIO synthesis hiccup shouldn't block the underlying
 * agent runs from persisting.
 */
export async function synthesizeCioBrief(
  candidates: CioCandidateItem[],
  taxableContext: TaxableAnalysisContext | null = null,
): Promise<CioBrief> {
  if (candidates.length === 0) {
    return { summary: fallbackSummary(candidates), orderedItems: [], taxableOpportunities: null };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { summary: fallbackSummary(candidates), orderedItems: candidates.slice(0, 8), taxableOpportunities: null };
  }

  const client = new Anthropic({ apiKey });
  const candidateSection = `This week's candidate items from the portfolio agents:\n\n${JSON.stringify(
    candidates.map(({ key, source, action, rationale, expectedImpact }) => ({
      key,
      source,
      action,
      rationale,
      expectedImpact,
    })),
    null,
    2,
  )}`;
  const userContent = taxableContext
    ? `${candidateSection}\n\n${taxableContextPrompt(taxableContext)}`
    : candidateSection;

  const message = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools: [BRIEF_TOOL],
    tool_choice: { type: "tool", name: "submit_cio_brief" },
    messages: [{ role: "user", content: userContent }],
  });

  const toolUse = message.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
  if (!toolUse) {
    throw new Error("Claude didn't return a structured CIO brief");
  }

  const input = toolUse.input as {
    summary: string;
    orderedKeys: string[];
    taxableOpportunities?: CioTaxableOpportunities;
  };
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const orderedItems = input.orderedKeys
    .map((k) => byKey.get(k))
    .filter((c): c is CioCandidateItem => Boolean(c));

  return {
    summary: input.summary,
    orderedItems: orderedItems.length > 0 ? orderedItems : candidates.slice(0, 8),
    taxableOpportunities: taxableContext ? input.taxableOpportunities ?? null : null,
  };
}
