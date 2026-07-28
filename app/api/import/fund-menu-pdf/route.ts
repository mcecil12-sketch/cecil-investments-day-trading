import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { PDF_FUND_MENU_EXTRACTION_SYSTEM_PROMPT, parseFundMenuPdfExtractionResponse } from "@/lib/portfolio/fundMenuPdfImport";
import { normalizeAsOfDate } from "@/lib/portfolio/dateNormalize";

const MAX_PDF_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_MEDIA_TYPES: Record<string, "image/png" | "image/jpeg"> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
};

/**
 * Fund menu documents come either as a full Fidelity PDF export or a
 * screenshot of the same plan performance page — same columns, same
 * extraction target, so both feed the same prompt/schema rather than
 * duplicating the whole pipeline the way Positions PDF vs. Positions
 * Screenshot ended up duplicated. Returns null for an unsupported type.
 */
function resolveContentBlock(
  file: File,
  base64: string,
): { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } }
  | { type: "image"; source: { type: "base64"; media_type: "image/png" | "image/jpeg"; data: string } }
  | null {
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } };
  }
  const imageMediaType = IMAGE_MEDIA_TYPES[file.type];
  if (imageMediaType) {
    return { type: "image", source: { type: "base64", media_type: imageMediaType, data: base64 } };
  }
  return null;
}

export async function POST(request: NextRequest) {
  const formData = await request.formData().catch(() => null);
  const files = formData?.getAll("file").filter((f): f is File => f instanceof File) ?? [];

  if (files.length === 0) {
    return NextResponse.json({ error: "Missing 'file' in form data" }, { status: 400 });
  }

  for (const file of files) {
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    const isImage = Boolean(IMAGE_MEDIA_TYPES[file.type]);
    if (!isPdf && !isImage) {
      return NextResponse.json({ error: `Only PDF, PNG, or JPG files are supported (got ${file.name})` }, { status: 400 });
    }
    const maxBytes = isPdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
    if (file.size > maxBytes) {
      return NextResponse.json(
        { error: `${file.name}: ${isPdf ? "PDF" : "Image"} must be under ${maxBytes / (1024 * 1024)}MB` },
        { status: 400 },
      );
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY is not configured on the server" },
      { status: 500 },
    );
  }

  // Files are sent as ordered content blocks in a single message — when more
  // than one is provided, the prompt's MULTIPLE IMAGES section instructs
  // Claude to treat them as sequential parts of one continuous table (e.g.
  // successive scroll screenshots) rather than independent documents.
  const contentBlocks = [];
  for (const file of files) {
    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    const block = resolveContentBlock(file, base64);
    if (!block) {
      return NextResponse.json({ error: `Only PDF, PNG, or JPG files are supported (got ${file.name})` }, { status: 400 });
    }
    contentBlocks.push(block);
  }
  const client = new Anthropic({ apiKey });

  let responseText: string;
  try {
    const message = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 8192,
      thinking: { type: "disabled" },
      system: [
        {
          type: "text",
          text: PDF_FUND_MENU_EXTRACTION_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            ...contentBlocks,
            {
              type: "text",
              text:
                files.length > 1
                  ? `Extract the complete fund menu from these ${files.length} images — they are sequential parts of one continuous table (e.g. successive scroll screenshots of the same plan performance page) — as a single combined JSON result.`
                  : "Extract the complete fund menu from this Fidelity plan performance page as JSON.",
            },
          ],
        },
      ],
    });

    const textBlock = message.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return NextResponse.json(
        { error: "Claude didn't return any readable content for this file" },
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
    const extracted = parseFundMenuPdfExtractionResponse(responseText);
    return NextResponse.json({ ...extracted, asOfDate: normalizeAsOfDate(extracted.asOfDate) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Couldn't understand the extracted data: ${message}` },
      { status: 502 },
    );
  }
}
