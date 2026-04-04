export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { checkAgentReadAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import { listAgentBriefs } from "@/lib/agents/store";

export async function GET(req: Request) {
  const auth = await checkAgentReadAuth(req);
  if (!auth.ok) {
    return unauthorizedAgentResponse(auth.error);
  }

  const briefs = await listAgentBriefs(1);
  return NextResponse.json({
    ok: true,
    brief: briefs[0] ?? null,
  });
}