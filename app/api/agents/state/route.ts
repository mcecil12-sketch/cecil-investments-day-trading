export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { checkAgentReadAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import { ensureAgentState, readAgentStateSnapshot } from "@/lib/agents/store";

export async function GET(req: Request) {
  const auth = await checkAgentReadAuth(req);
  if (!auth.ok) {
    return unauthorizedAgentResponse(auth.error);
  }

  const snapshot = await readAgentStateSnapshot();
  const state = await ensureAgentState();

  return NextResponse.json({
    ok: true,
    state,
    initialized: snapshot.source !== "stored",
  });
}