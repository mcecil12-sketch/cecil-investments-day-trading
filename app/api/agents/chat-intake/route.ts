export const dynamic = "force-dynamic";

/**
 * POST /api/agents/chat-intake
 *
 * Canonical conversation-facing endpoint for agent task creation.
 *
 * Accepts EITHER:
 *   1. Structured task JSON  (title, description, priority, taskType, …)
 *   2. Conversational message  { message: "Execute the following task: …" }
 *
 * When a `message` field is present and starts with the trigger phrase the
 * conversational parser extracts structured fields before validation runs,
 * so callers never hit "Missing required field" errors for well-formed
 * conversational payloads.
 *
 * Returns a compact, GPT-friendly response that includes current queue
 * context (active task, latest execution, queue counts) so callers get a
 * complete picture in one round-trip.
 *
 * Additional behavior:
 *  - For patchable executionReady tasks missing fileHints, executionReady
 *    is safely downgraded to false with a warning.
 *  - source defaults to "chat_intake".
 */

import { NextRequest, NextResponse } from "next/server";
import { checkAgentReadAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import { runIntakePipeline } from "@/lib/agents/intake-pipeline";

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

  const result = await runIntakePipeline(body);
  return NextResponse.json(result.body, { status: result.status });
}
