export const AGENT_STATE_KEY = "agents:state:v1";
export const AGENT_BRIEFS_KEY = "agents:briefs:v1";
export const AGENT_INCIDENTS_KEY = "agents:incidents:v1";
export const AGENT_ACTIONS_KEY = "agents:actions:v1";
export const AGENT_ENGINEERING_KEY = "agents:engineering:v1";
export const AGENT_BACKLOG_KEY = "agents:backlog:v1";

// Phase 3 keys
export const AGENT_EXECUTION_IMPACT_KEY = "agents:execution_impact:v1";
export const AGENT_STRATEGIST_KEY = "agents:strategist:v1";
export const AGENT_PERF_LEARNING_KEY = "agents:perf_learning:v1";
export const AGENT_EM_BRIEF_KEY = "agents:em_brief:v1";

export const AGENT_STORE_KEYS = {
  state: AGENT_STATE_KEY,
  briefs: AGENT_BRIEFS_KEY,
  incidents: AGENT_INCIDENTS_KEY,
  actions: AGENT_ACTIONS_KEY,
  engineering: AGENT_ENGINEERING_KEY,
  backlog: AGENT_BACKLOG_KEY,
  executionImpact: AGENT_EXECUTION_IMPACT_KEY,
  strategist: AGENT_STRATEGIST_KEY,
  perfLearning: AGENT_PERF_LEARNING_KEY,
  emBrief: AGENT_EM_BRIEF_KEY,
} as const;