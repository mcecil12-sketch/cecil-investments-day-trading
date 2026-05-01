export const dynamic = "force-dynamic";

/**
 * POST /api/agents/chat-intake-public
 *
 * Secure external relay for GPT Action → Cecil agent system.
 *
 * Authenticates via `x-chat-intake-token` header (matched against
 * env var CHAT_INTAKE_TOKEN).  Does NOT require cookies or app-PIN auth,
 * making it suitable for custom-GPT Action calls.
 *
 * Accepts:
 *   { message: string, executeOverride?: boolean | null }
 *
 * Internally pre-resolves the conversational message, applies the optional
 * executeOverride, stamps source as "chat_action_intake", then delegates to
 * the canonical runIntakePipeline for normalisation, dedup, creation,
 * auto-execute evaluation and compact-state assembly — so no safety logic
 * is duplicated or bypassed.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  runIntakePipeline,
} from "@/lib/agents/intake-pipeline";

// ─── Token auth (no cookies, no app-PIN) ────────────────────────────

function checkPublicIntakeAuth(
  req: NextRequest,
): { ok: true } | { ok: false; error: string } {
  const expected = process.env.CHAT_INTAKE_TOKEN ?? "";
  if (!expected) {
    return { ok: false, error: "CHAT_INTAKE_TOKEN not configured on server" };
  }

  const provided = req.headers.get("x-chat-intake-token") ?? "";
  if (!provided || provided !== expected) {
    return { ok: false, error: "unauthorized" };
  }

  return { ok: true };
}

// ─── POST handler ───────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // 1. Auth
  const auth = checkPublicIntakeAuth(req);
  if (!auth.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: auth.error,
        message:
          auth.error === "unauthorized"
            ? "Missing or invalid x-chat-intake-token"
            : auth.error,
      },
      { status: 401 },
    );
  }

  // 2. Parse body
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  // 3. Accept either structured intake payload or message-only payload.
  const payload: Record<string, unknown> = {
    ...body,
    source: "chat_action_intake",
  };

  // 4. Apply executeOverride when explicitly provided
  const executeOverride = body.executeOverride;
  if (executeOverride === true || executeOverride === false) {
    payload.executionReady = executeOverride;
    payload.execute = executeOverride;
  }
  // null / undefined → keep payload value as provided

  // 6. Delegate to the canonical pipeline (structured path — no re-parse)
  const result = await runIntakePipeline(payload as Record<string, unknown>);

  // Log a lightweight trace (non-blocking, server-only)
  try {
    const taskId =
      (result.body as Record<string, unknown>).task &&
      ((result.body as Record<string, unknown>).task as Record<string, unknown>).id;
    console.log(
      "[chat-intake-public]",
      JSON.stringify({
        ts: new Date().toISOString(),
        taskId: taskId ?? null,
        created: (result.body as Record<string, unknown>).created ?? null,
        deduped: (result.body as Record<string, unknown>).deduped ?? null,
        autoExecute: (result.body as Record<string, unknown>).autoExecute ?? null,
        status: result.status,
      }),
    );
  } catch {
    // logging must never break the response
  }

  return NextResponse.json(result.body, { status: result.status });
}
