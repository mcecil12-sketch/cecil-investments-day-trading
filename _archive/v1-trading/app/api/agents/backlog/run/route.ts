export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { checkAgentReadAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import { getNextBacklogItems, updateBacklogStatus } from "@/lib/agents/store";

export async function POST(req: Request) {
  const auth = await checkAgentReadAuth(req);
  if (!auth.ok) {
    return unauthorizedAgentResponse(auth.error);
  }

  let limit = 3;
  try {
    const body = (await req.json()) as { limit?: number };
    if (typeof body?.limit === "number" && Number.isFinite(body.limit)) {
      limit = Math.min(10, Math.max(1, Math.floor(body.limit)));
    }
  } catch {
    // empty body is fine
  }

  const selected = await getNextBacklogItems(limit);
  const prepared = [];

  for (const item of selected) {
    if (item.status === "OPEN") {
      const updated = await updateBacklogStatus(item.id, "READY");
      prepared.push(updated ?? item);
    } else {
      prepared.push(item);
    }
  }

  return NextResponse.json({
    ok: true,
    authMode: auth.authMode,
    selectedCount: prepared.length,
    selected: prepared,
    order: "priority_high_to_low",
  });
}

export async function GET(req: Request) {
  return POST(req);
}
