export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { checkAgentCronAuth, unauthorizedAgentResponse } from "@/lib/agents/auth";
import { runEngineeringManagerAgent } from "@/lib/agents/runners/engineering-manager";
import { ALL_AGENT_RUN_ORDER, AGENT_RUNNERS } from "@/lib/agents/runners";
import { ensureAgentState, readAgentState } from "@/lib/agents/store";
import { runEmOrchestration } from "@/lib/agents/engineeringManager";
import type { AgentName } from "@/lib/agents/types";

type AgentRunRequest = AgentName | "all";

function isAgentRunRequest(value: string): value is AgentRunRequest {
  return value === "all" || value in AGENT_RUNNERS;
}

async function getRequestedAgent(req: Request): Promise<AgentRunRequest | null> {
  const url = new URL(req.url);
  const fromQuery = url.searchParams.get("agent");
  if (fromQuery && isAgentRunRequest(fromQuery)) return fromQuery;

  try {
    const body = (await req.json()) as { agent?: string };
    if (body?.agent && isAgentRunRequest(body.agent)) {
      return body.agent;
    }
  } catch {}

  return fromQuery ? null : "all";
}

export async function POST(req: Request) {
  const auth = checkAgentCronAuth(req);
  if (!auth.ok) {
    return unauthorizedAgentResponse(auth.error);
  }

  const requested = await getRequestedAgent(req);
  if (!requested) {
    return NextResponse.json(
      { ok: false, error: "invalid_agent", allowed: [...ALL_AGENT_RUN_ORDER, "all"] },
      { status: 400 }
    );
  }

  await ensureAgentState();
  const runList = requested === "all"
    ? ALL_AGENT_RUN_ORDER
    : requested === "engineering-manager"
      ? []
      : [requested];
  const results = [];
  const ran: string[] = [];

  for (const agent of runList) {
    const result = await AGENT_RUNNERS[agent]();
    ran.push(agent);
    results.push({
      agent: result.agent,
      summary: result.summary,
      briefId: result.briefId ?? null,
      actionId: result.actionId ?? null,
      incidentId: result.incidentId ?? null,
      engineeringTaskId: result.engineeringTaskId ?? null,
    });
  }

  const state = await readAgentState();
  const noIncidents = state?.activeIncidentCount === 0;

  if ((requested === "all" || requested === "engineering-manager") && noIncidents) {
    try {
      const managerResult = await runEngineeringManagerAgent({ state });
      ran.push("engineering-manager");
      results.push({
        agent: "engineering-manager",
        summary: managerResult.summary,
        briefId: managerResult.briefId ?? null,
        actionId: managerResult.actionId ?? null,
        incidentId: managerResult.incidentId ?? null,
        engineeringTaskId: managerResult.engineeringTaskId ?? null,
      });
    } catch (err) {
      console.error("engineering-manager error", err);
    }

    // Phase 3: run EM orchestration (scoring + strategist + learning signals)
    try {
      await runEmOrchestration();
    } catch (err) {
      console.warn("EM orchestration error (non-fatal)", err);
    }
  }

  const finalState = await readAgentState();

  if (ran.includes("engineering-manager")) {
    try {
      await fetch(new URL("/api/agents/execute", req.url), {
        method: "POST",
        headers: {
          "x-cron-token": process.env.CRON_TOKEN || process.env.CRON_SECRET || "",
        },
        cache: "no-store",
      });
    } catch (e) {
      console.warn("Execution trigger failed", e);
    }
  }

  return NextResponse.json({
    ok: true,
    authMode: "cron_token",
    requested,
    ran,
    results,
    state: finalState,
  });
}