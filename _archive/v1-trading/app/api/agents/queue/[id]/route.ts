export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { checkAgentCronAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import {
  getManualActionTask,
  updateManualActionTask,
  cancelManualActionTask,
  type ManualActionTaskPatch,
} from "@/lib/agents/manual-action-queue";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = checkAgentCronAuth(req);
  if (!auth.ok) return unauthorizedAgentResponse(auth.error);

  const { id } = await params;
  const task = await getManualActionTask(id);
  if (!task) {
    return NextResponse.json({ ok: false, error: "Task not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, task });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = checkAgentCronAuth(req);
  if (!auth.ok) return unauthorizedAgentResponse(auth.error);

  const { id } = await params;

  let body: ManualActionTaskPatch;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const allowedKeys = new Set([
    "status",
    "priority",
    "executionReady",
    "blockedReason",
    "acceptanceCriteria",
    "fileHints",
    "routeHints",
    "latestExecutionResult",
  ]);
  const patch: ManualActionTaskPatch = {};
  for (const key of Object.keys(body)) {
    if (allowedKeys.has(key)) {
      (patch as Record<string, unknown>)[key] = (body as Record<string, unknown>)[key];
    }
  }

  const task = await updateManualActionTask(id, patch);
  if (!task) {
    return NextResponse.json({ ok: false, error: "Task not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, task });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = checkAgentCronAuth(req);
  if (!auth.ok) return unauthorizedAgentResponse(auth.error);

  const { id } = await params;
  const reason = new URL(req.url).searchParams.get("reason") ?? undefined;

  const task = await cancelManualActionTask(id, reason);
  if (!task) {
    return NextResponse.json({ ok: false, error: "Task not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, task });
}
