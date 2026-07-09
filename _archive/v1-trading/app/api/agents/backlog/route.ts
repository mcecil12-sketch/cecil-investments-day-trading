export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { checkAgentReadAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import { listBacklogItems, upsertBacklogItem } from "@/lib/agents/store";
import type { BacklogItemPriority, BacklogItemStatus, BacklogItemType } from "@/lib/agents/types";

function groupedCounts(items: Array<{ status: BacklogItemStatus }>) {
  return {
    OPEN: items.filter((item) => item.status === "OPEN").length,
    READY: items.filter((item) => item.status === "READY").length,
    IN_PROGRESS: items.filter((item) => item.status === "IN_PROGRESS").length,
    REVIEW: items.filter((item) => item.status === "REVIEW").length,
    DONE: items.filter((item) => item.status === "DONE").length,
  };
}

export async function GET(req: Request) {
  const auth = await checkAgentReadAuth(req);
  if (!auth.ok) {
    return unauthorizedAgentResponse(auth.error);
  }

  const items = await listBacklogItems(200);
  return NextResponse.json({
    ok: true,
    authMode: auth.authMode,
    items,
    counts: groupedCounts(items),
    openCount: items.filter((item) => item.status !== "DONE").length,
  });
}

type BacklogCreatePayload = {
  status?: BacklogItemStatus;
  type?: BacklogItemType;
  priority?: BacklogItemPriority;
  title?: string;
  summary?: string;
  likelyFiles?: string[];
  copilotPrompt?: string;
  smokeTestBlock?: string;
  gitBlock?: string;
  linkedIncidentId?: string | null;
  assignedAgent?: "engineering" | "ops" | "pm" | null;
  notes?: string[];
};

export async function POST(req: Request) {
  const auth = await checkAgentReadAuth(req);
  if (!auth.ok) {
    return unauthorizedAgentResponse(auth.error);
  }

  let body: BacklogCreatePayload;
  try {
    body = (await req.json()) as BacklogCreatePayload;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const title = String(body.title || "").trim();
  const summary = String(body.summary || "").trim();
  if (!title || !summary) {
    return NextResponse.json(
      { ok: false, error: "invalid_payload", message: "title and summary are required" },
      { status: 400 },
    );
  }

  const result = await upsertBacklogItem({
    status: body.status ?? "OPEN",
    type: body.type ?? "TECH_DEBT",
    priority: body.priority ?? "MEDIUM",
    title,
    summary,
    likelyFiles: body.likelyFiles,
    copilotPrompt: body.copilotPrompt,
    smokeTestBlock: body.smokeTestBlock,
    gitBlock: body.gitBlock,
    linkedIncidentId: body.linkedIncidentId ?? null,
    assignedAgent: body.assignedAgent ?? "engineering",
    notes: body.notes,
  });

  const items = await listBacklogItems(200);
  return NextResponse.json({
    ok: true,
    authMode: auth.authMode,
    created: result.created,
    item: result.item,
    counts: groupedCounts(items),
  });
}
