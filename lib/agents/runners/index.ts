import type { AgentName, AgentRunnerResult } from "@/lib/agents/types";
import { runEngineeringAgent } from "./engineering";
import { runOpsAgent } from "./ops";
import { runPmAgent } from "./pm";
import { runPolicyNewsAgent } from "./policyNews";
import { runRiskAgent } from "./risk";

export const AGENT_RUNNERS: Record<AgentName, () => Promise<AgentRunnerResult>> = {
  pm: runPmAgent,
  risk: runRiskAgent,
  ops: runOpsAgent,
  policynews: runPolicyNewsAgent,
  engineering: runEngineeringAgent,
};

export const ALL_AGENT_RUN_ORDER: AgentName[] = ["policynews", "ops", "pm", "risk", "engineering"];