export const AGENT_STATE_KEY = "agents:state:v1";
export const AGENT_BRIEFS_KEY = "agents:briefs:v1";
export const AGENT_INCIDENTS_KEY = "agents:incidents:v1";
export const AGENT_ACTIONS_KEY = "agents:actions:v1";
export const AGENT_ENGINEERING_KEY = "agents:engineering:v1";

export const AGENT_STORE_KEYS = {
  state: AGENT_STATE_KEY,
  briefs: AGENT_BRIEFS_KEY,
  incidents: AGENT_INCIDENTS_KEY,
  actions: AGENT_ACTIONS_KEY,
  engineering: AGENT_ENGINEERING_KEY,
} as const;