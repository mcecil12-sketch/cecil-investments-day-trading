export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { checkAgentReadAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import { listAgentBriefs } from "@/lib/agents/store";
import { getEtDateString } from "@/lib/time/etDate";

export async function GET(req: Request) {
  const auth = await checkAgentReadAuth(req);
  if (!auth.ok) {
    return unauthorizedAgentResponse(auth.error);
  }

  const url = new URL(req.url);
  const limitParam = Number(url.searchParams.get("limit") ?? "25");
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(100, Math.floor(limitParam)) : 25;
  const todayEt = getEtDateString();
  const briefs = await listAgentBriefs(Math.max(limit, 50));

  const today = briefs.filter((brief) => {
    const createdAt = Date.parse(brief.createdAt);
    if (!Number.isFinite(createdAt)) return false;
    return getEtDateString(new Date(createdAt)) === todayEt;
  });

  return NextResponse.json({
    ok: true,
    date: todayEt,
    briefs: today.slice(0, limit),
  });
}