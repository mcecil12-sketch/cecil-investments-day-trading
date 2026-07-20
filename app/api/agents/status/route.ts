import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { AgentRunStatus, AgentType } from "@/lib/generated/prisma";

export const dynamic = "force-dynamic";

const AGENT_KEYS: Record<"relativeStrength" | "sectorRotation" | "riskManager", AgentType> = {
  relativeStrength: "RELATIVE_STRENGTH",
  sectorRotation: "SECTOR_ROTATION",
  riskManager: "RISK_MANAGER",
};

export interface AgentStatusResponse {
  relativeStrength: AgentRunStatus | null;
  sectorRotation: AgentRunStatus | null;
  riskManager: AgentRunStatus | null;
}

/** Returns each agent's latest run status so the /agents page can poll for RUNNING -> COMPLETE/FAILED transitions without a full page reload. */
export async function GET() {
  const entries = Object.entries(AGENT_KEYS) as [keyof typeof AGENT_KEYS, AgentType][];

  const runs = await Promise.all(
    entries.map(([, agentType]) =>
      prisma.agentRun.findFirst({
        where: { agentType },
        orderBy: { startedAt: "desc" },
        select: { status: true },
      }),
    ),
  );

  const result = {} as AgentStatusResponse;
  entries.forEach(([key], i) => {
    result[key] = runs[i]?.status ?? null;
  });

  return NextResponse.json(result);
}
