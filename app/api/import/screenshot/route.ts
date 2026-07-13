import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { EXTRACTION_SYSTEM_PROMPT, parseExtractionResponse } from "@/lib/portfolio/screenshotImport";

const ALLOWED_MEDIA_TYPES: Record<string, "image/png" | "image/jpeg"> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
};

const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Claude sometimes returns asOfDate as something like "Jul-10-2026 at 5:58
 * p.m. ET" despite the prompt asking for YYYY-MM-DD — strip the time/timezone
 * suffix and the dashes so `new Date()` has a shot at parsing it, and fall
 * back to today rather than failing the whole import over a date string.
 */
function normalizeAsOfDate(raw: string): string {
  const cleaned = raw.split(/\s+at\s+/i)[0].replace(/-/g, " ").trim();
  const parsed = new Date(cleaned);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return parsed.toISOString().slice(0, 10);
}

export async function POST(request: NextRequest) {
  const formData = await request.formData().catch(() => null);
  const file = formData?.get("file");

  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' in form data" }, { status: 400 });
  }

  const mediaType = ALLOWED_MEDIA_TYPES[file.type];
  if (!mediaType) {
    return NextResponse.json(
      { error: "Only PNG and JPG screenshots are supported" },
      { status: 400 },
    );
  }
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: "Screenshot must be under 10MB" }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not configured on the server" },
      { status: 500 },
    );
  }

  const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
  const client = new Anthropic({ apiKey });

  let responseText: string;
  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
            { type: "text", text: "Extract the portfolio positions from this screenshot as JSON." },
          ],
        },
      ],
    });

    const textBlock = message.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return NextResponse.json(
        { error: "Claude didn't return any readable content for this screenshot" },
        { status: 502 },
      );
    }
    responseText = textBlock.text;
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return NextResponse.json(
        { error: "Claude is rate-limiting requests right now — try again shortly" },
        { status: 429 },
      );
    }
    if (err instanceof Anthropic.AuthenticationError) {
      return NextResponse.json(
        { error: "Claude API authentication failed — check ANTHROPIC_API_KEY" },
        { status: 500 },
      );
    }
    if (err instanceof Anthropic.APIError) {
      return NextResponse.json(
        { error: `Claude API error: ${err.message}` },
        { status: 502 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Extraction request failed: ${message}` }, { status: 502 });
  }

  try {
    const extracted = parseExtractionResponse(responseText);
    return NextResponse.json({ ...extracted, asOfDate: normalizeAsOfDate(extracted.asOfDate) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Couldn't understand the extracted data: ${message}` },
      { status: 502 },
    );
  }
}
