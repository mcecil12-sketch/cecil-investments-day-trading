export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { checkAgentReadAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import { listAgentBriefs } from "@/lib/agents/store";
import { getEtDateString, getEtDateStringFromTimestamp } from "@/lib/agents/time";

export async function GET(req: Request) {
  const auth = await checkAgentReadAuth(req);
  if (!auth.ok) {
    return unauthorizedAgentResponse(auth.error);
  }

  const url = new URL(req.url);
  const limitParam = Number(url.searchParams.get("limit") ?? "25");
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(100, Math.floor(limitParam)) : 25;
  const todayEt = getEtDateString();
  const briefs = await listAgentBriefs(Math.max(limit, 200));

  const today = briefs.filter((brief) => {
    if (typeof brief.etDate === "string" && brief.etDate) {
      return brief.etDate === todayEt;
    }
    const etDate = getEtDateStringFromTimestamp(brief.createdAt);
    return etDate === todayEt;
  });

  return NextResponse.json({
    ok: true,
    date: todayEt,
    briefs: today.slice(0, limit),
  });
}