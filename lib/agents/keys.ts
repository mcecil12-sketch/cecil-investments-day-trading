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

// Phase 4 keys
export const AGENT_ADAPTIVE_GUARDRAILS_KEY = "agents:adaptive_guardrails:v1";
export const AGENT_LATEST_EXECUTION_KEY = "agents:latest_execution:v1";

// Phase 5 keys
export const AGENT_LEARNING_LEDGER_KEY = "agents:learning_ledger:v1";

// Batch execution keys
export const AGENT_LATEST_BATCH_EXECUTION_KEY = "agents:latest_batch_execution:v1";

// Manual action queue
export const AGENT_MANUAL_QUEUE_KEY = "agents:manual_queue:v1";

// Profit Optimization Engine keys
export const AGENT_PROFIT_ENGINE_KEY = "agents:profit_engine:v1";
export const AGENT_EXPERIMENT_TRACKER_KEY = "agents:experiments:v1";

// Agent Workflow v2 keys
export const AGENT_FUNNEL_RECOVERY_KEY = "agents:funnel_recovery:v2";
export const AGENT_EXECUTION_DEDUP_STATS_KEY = "agents:execution_dedup_stats:v2";
// Tracks the ISO timestamp when the market was first detected open for the current session
export const AGENT_MARKET_OPEN_SINCE_KEY = "agents:market_open_since:v1";

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
  adaptiveGuardrails: AGENT_ADAPTIVE_GUARDRAILS_KEY,
  latestExecution: AGENT_LATEST_EXECUTION_KEY,
  latestBatchExecution: AGENT_LATEST_BATCH_EXECUTION_KEY,
  learningLedger: AGENT_LEARNING_LEDGER_KEY,
  manualQueue: AGENT_MANUAL_QUEUE_KEY,
} as const;