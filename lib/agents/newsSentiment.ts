import Anthropic from "@anthropic-ai/sdk";

export type NewsSentimentNoteType = "watchout" | "tailwind";

export interface NewsSentimentNote {
  symbol: string;
  name: string;
  noteType: NewsSentimentNoteType;
  note: string;
  sourceHint: string;
}

interface CandidateInput {
  symbol: string;
  name: string;
}

const MODEL = "claude-sonnet-5";
const MAX_SEARCHES_PER_CANDIDATE = 2;
const CONCURRENCY = 4;

const NOTE_SCHEMA = {
  type: "object",
  properties: {
    noteType: {
      type: "string",
      enum: ["watchout", "tailwind", "none"],
      description:
        "'watchout' for cautionary news (guidance cut, negative surprise, downgrade), 'tailwind' for supportive news (beat, upgrade, positive commentary), 'none' if nothing material and recent turned up.",
    },
    note: {
      type: "string",
      description:
        "1-2 sentence plain-language note on the material news. Empty string if noteType is 'none'.",
    },
    sourceHint: {
      type: "string",
      description:
        "Very brief tag for what the news was, e.g. 'Q2 earnings beat + raised guidance' or 'downgrade from Morgan Stanley'. Empty string if noteType is 'none'.",
    },
  },
  required: ["noteType", "note", "sourceHint"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are a research analyst doing a quick, qualitative news check on a single stock as part of a household investment brief. Search for recent, MATERIAL, company-specific news from roughly the past 1-2 weeks: earnings surprises, guidance changes, analyst upgrades/downgrades, or major company-specific events (M&A, leadership change, regulatory action, major product news).

Do not report routine price movement, generic sector commentary, or stale news older than ~2 weeks. If you don't find anything genuinely material and recent, set noteType to "none" — do not force a note where there is nothing real to say. This is qualitative color for a human reader, not a scoring input, so keep it concise and concrete (name the specific event).`;

async function researchCandidate(
  client: Anthropic,
  symbol: string,
  name: string,
): Promise<NewsSentimentNote | null> {
  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      output_config: { effort: "low", format: { type: "json_schema", schema: NOTE_SCHEMA } },
      tools: [
        { type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES_PER_CANDIDATE },
      ],
      messages: [
        {
          role: "user",
          content: `Ticker: ${symbol} (${name}). Search for material, company-specific news from roughly the past 1-2 weeks and report back.`,
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return null;

    const parsed = JSON.parse(textBlock.text) as { noteType: string; note: string; sourceHint: string };
    if (parsed.noteType !== "watchout" && parsed.noteType !== "tailwind") return null;
    return { symbol, name, noteType: parsed.noteType, note: parsed.note, sourceHint: parsed.sourceHint };
  } catch (err) {
    console.error(`News sentiment check failed for ${symbol}:`, err);
    return null;
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Qualitative, human-facing news/sentiment color for this week's Top
 * Candidates — explicitly NOT a scoring input. The composite score in
 * candidateScanner.ts (CandidateEntry.score) still renormalizes away the 10%
 * sentiment/news weight pending a real data source; this does not change
 * that. Runs a low-effort Claude call with web search per candidate and
 * keeps only genuinely material (watchout/tailwind) notes. Returns [] when
 * ANTHROPIC_API_KEY is missing or there are no candidates, so weekly brief
 * synthesis is never blocked by this step.
 */
export async function generateNewsSentimentNotes(candidates: CandidateInput[]): Promise<NewsSentimentNote[]> {
  if (candidates.length === 0) return [];
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];

  const client = new Anthropic({ apiKey });
  const results = await mapWithConcurrency(candidates, CONCURRENCY, (c) =>
    researchCandidate(client, c.symbol, c.name),
  );
  return results.filter((r): r is NewsSentimentNote => r !== null);
}
