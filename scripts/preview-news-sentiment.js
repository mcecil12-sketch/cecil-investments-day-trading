// Standalone prototype — NOT wired into the app. Prints a sample "News & Sentiment
// Watch" section for the current live Top 15 candidates so it can be reviewed before
// building it into the weekly CIO brief for real. Run with:
//   env $(grep '^DATABASE_URL=' .env.local) node scripts/preview-news-sentiment.js
"use strict";

const { PrismaClient } = require("../lib/generated/prisma");
const Anthropic = require("@anthropic-ai/sdk").default;

const prisma = new PrismaClient();
const anthropic = new Anthropic();

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

// Guards against rare cases where the model's raw scratch reasoning leaks into the note field despite otherwise-valid JSON (e.g. "]);}}}}} Let me finalize."). Better to drop the note than surface garbage in the household brief.
function looksLikeLeakedReasoning(text) {
  if (/[{}\[\];]{2,}/.test(text)) return true;
  return /\b(let me|i'll|wait,|need proper json)\b/i.test(text);
}

async function researchCandidate(symbol, name) {
  const response = await anthropic.messages.create({
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
  if (!textBlock) return { symbol, name, noteType: "none", note: "", sourceHint: "", error: "no text block returned" };
  try {
    const parsed = JSON.parse(textBlock.text);
    if (
      (parsed.noteType === "watchout" || parsed.noteType === "tailwind") &&
      (looksLikeLeakedReasoning(parsed.note) || looksLikeLeakedReasoning(parsed.sourceHint))
    ) {
      return { symbol, name, noteType: "none", note: "", sourceHint: "", error: "leaked-reasoning artifact discarded" };
    }
    return { symbol, name, ...parsed };
  } catch (e) {
    return { symbol, name, noteType: "none", note: "", sourceHint: "", error: `parse failure: ${e.message}` };
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function renderSection(results) {
  const material = results.filter((r) => r.noteType === "watchout" || r.noteType === "tailwind");
  const lines = [];
  lines.push("## News & Sentiment Watch");
  lines.push("");
  lines.push(
    "_Qualitative context only — not a scoring input, not part of the composite or the ranking above. Recent (past 1-2 week) company-specific news for Top 15 candidates, surfaced for human judgment._",
  );
  lines.push("");
  if (material.length === 0) {
    lines.push("No material recent news surfaced for any Top 15 candidate this week.");
  } else {
    for (const r of material) {
      const label = r.noteType === "watchout" ? "⚠️ Watchout" : "✅ Tailwind";
      lines.push(`- **${r.symbol}** (${r.name}) — ${label}: ${r.note}`);
    }
  }
  const errors = results.filter((r) => r.error);
  if (errors.length > 0) {
    lines.push("");
    lines.push(`_(${errors.length} candidate(s) failed to process cleanly — see stderr.)_`);
  }
  return lines.join("\n");
}

async function main() {
  const run = await prisma.agentRun.findFirst({
    where: { agentType: "CANDIDATE_SCANNER", status: "COMPLETE" },
    orderBy: { startedAt: "desc" },
  });
  if (!run || !run.output || !Array.isArray(run.output.topCandidates)) {
    console.error("No completed CANDIDATE_SCANNER run with topCandidates found.");
    process.exit(1);
  }
  const candidates = run.output.topCandidates;
  console.error(`Using candidate scan from ${run.startedAt.toISOString()} (${candidates.length} candidates).`);
  console.error(`Running up to ${MAX_SEARCHES_PER_CANDIDATE} web searches per candidate, ${CONCURRENCY}-way concurrency...`);

  const results = await mapWithConcurrency(candidates, CONCURRENCY, async (c) => {
    try {
      const r = await researchCandidate(c.symbol, c.name);
      console.error(`  ${c.symbol}: ${r.noteType}${r.error ? ` (error: ${r.error})` : ""}`);
      return r;
    } catch (e) {
      console.error(`  ${c.symbol}: FAILED — ${e.message}`);
      return { symbol: c.symbol, name: c.name, noteType: "none", note: "", sourceHint: "", error: e.message };
    }
  });

  console.log("\n" + renderSection(results) + "\n");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
