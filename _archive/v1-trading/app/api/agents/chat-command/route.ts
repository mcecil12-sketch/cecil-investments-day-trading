export const dynamic = "force-dynamic";

/**
 * POST /api/agents/chat-command
 *
 * Conversational execution trigger for agent intake.
 *
 * Accepts a JSON body with a `message` field.  When the message starts with
 * "Execute the following task:" the body is parsed for structured fields and
 * fed into the shared intake pipeline.
 *
 * This route delegates entirely to /lib/agents/intake-pipeline so that
 * behaviour stays in sync with /api/agents/chat-intake (the canonical
 * conversation-facing endpoint).
 *
 * Defaults:
 *   Type     = OPS
 *   Priority = MEDIUM
 *   Execute  = false
 *
 * Returns the same compact JSON envelope as /api/agents/chat-intake.
 */

import { NextRequest, NextResponse } from "next/server";
import { checkAgentReadAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import { runIntakePipeline, isConversationalTask } from "@/lib/agents/intake-pipeline";

// ─── POST handler ───────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const auth = await checkAgentReadAuth(req);
  if (!auth.ok) {
    return unauthorizedAgentResponse(auth.error);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  // This endpoint requires a message field with the trigger phrase
  const message = typeof body.message === "string" ? body.message : "";
  if (!message) {
    return NextResponse.json(
      { ok: false, error: "Missing required field: message" },
      { status: 400 },
    );
  }

  if (!isConversationalTask(message)) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Message must begin with "Execute the following task:"',
      },
      { status: 400 },
    );
  }

  const result = await runIntakePipeline(body);
  return NextResponse.json(result.body, { status: result.status });
}
