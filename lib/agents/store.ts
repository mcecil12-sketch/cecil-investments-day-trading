import { redis } from "@/lib/redis";
import { getTtlSeconds, setWithTtl } from "@/lib/redis/ttl";
import { getEtNowIso } from "@/lib/time/etDate";
import { getTradingConfig } from "@/lib/tradingConfig";
import {
  AGENT_ACTIONS_KEY,
  AGENT_BRIEFS_KEY,
  AGENT_ENGINEERING_KEY,
  AGENT_INCIDENTS_KEY,
  AGENT_STATE_KEY,
} from "./keys";
import type {
  AgentAction,
  AgentBrief,
  AgentIncident,
  AgentName,
  AgentPosture,
  AgentState,
  AllowedGrade,
  EngineeringTask,
  EventRisk,
  FreezeWindow,
  NewsState,
} from "./types";

const STORE_TTL_SECONDS = getTtlSeconds("TELEMETRY_DAYS");
const HISTORY_LIMIT = 150;

const VALID_POSTURES = new Set<AgentPosture>(["AGGRESSIVE", "NORMAL", "DEFENSIVE"]);
const VALID_EVENT_RISK = new Set<EventRisk>(["LOW", "MEDIUM", "HIGH"]);
const VALID_NEWS_STATE = new Set<NewsState>(["CALM", "ACTIVE", "HEADLINE_DRIVEN"]);
const VALID_ALLOWED_GRADES = new Set<AllowedGrade>(["A", "B", "C"]);
const VALID_UPDATED_BY = new Set<AgentName | "system">([
  "pm",
  "risk",
  "ops",
  "policynews",
  "engineering",
  "system",
]);

export type AgentStateSource = "stored" | "missing" | "invalid" | "unavailable";

export interface AgentStateSnapshot {
  state: AgentState;
  source: AgentStateSource;
}

function defaultAllowedGrades(): AllowedGrade[] {
  return getTradingConfig().flags.allowTierCAutoEntry ? ["A", "B", "C"] : ["A", "B"];
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function normalizeFreezeWindow(input: unknown): FreezeWindow | null {
  if (!input || typeof input !== "object") return null;
  const candidate = input as Partial<FreezeWindow>;
  if (typeof candidate.start !== "string" || typeof candidate.end !== "string" || typeof candidate.reason !== "string") {
    return null;
  }
  return {
    start: candidate.start,
    end: candidate.end,
    reason: candidate.reason,
  };
}

function normalizeState(raw: unknown): AgentState | null {
  if (!raw || typeof raw !== "object") return null;

  const candidate = raw as Partial<AgentState>;
  const posture = VALID_POSTURES.has(candidate.posture as AgentPosture) ? candidate.posture : null;
  const eventRisk = VALID_EVENT_RISK.has(candidate.eventRisk as EventRisk) ? candidate.eventRisk : null;
  const newsState = VALID_NEWS_STATE.has(candidate.newsState as NewsState) ? candidate.newsState : null;
  const updatedBy = VALID_UPDATED_BY.has(candidate.updatedBy as AgentName | "system") ? candidate.updatedBy : null;

  if (
    typeof candidate.asOf !== "string" ||
    !posture ||
    !eventRisk ||
    !newsState ||
    !updatedBy ||
    !Array.isArray(candidate.allowedGrades) ||
    !Array.isArray(candidate.freezeWindows) ||
    !Array.isArray(candidate.activeRestrictions) ||
    typeof candidate.minScoreAdjustment !== "number" ||
    !Number.isFinite(candidate.minScoreAdjustment) ||
    (candidate.maxEntriesOverride != null && (!Number.isFinite(candidate.maxEntriesOverride) || candidate.maxEntriesOverride < 0)) ||
    typeof candidate.activeIncidentCount !== "number" ||
    !Number.isFinite(candidate.activeIncidentCount)
  ) {
    return null;
  }

  const allowedGrades = candidate.allowedGrades.filter(
    (grade): grade is AllowedGrade => VALID_ALLOWED_GRADES.has(grade as AllowedGrade)
  );

  return {
    asOf: candidate.asOf,
    posture,
    eventRisk,
    newsState,
    allowedGrades: allowedGrades.length > 0 ? Array.from(new Set(allowedGrades)) : defaultAllowedGrades(),
    minScoreAdjustment: candidate.minScoreAdjustment,
    maxEntriesOverride:
      typeof candidate.maxEntriesOverride === "number" && Number.isFinite(candidate.maxEntriesOverride)
        ? candidate.maxEntriesOverride
        : null,
    freezeWindows: candidate.freezeWindows.map(normalizeFreezeWindow).filter((window): window is FreezeWindow => Boolean(window)),
    activeRestrictions: uniqueStrings(
      candidate.activeRestrictions.filter((value): value is string => typeof value === "string")
    ),
    activeIncidentCount: Math.max(0, Math.floor(candidate.activeIncidentCount)),
    latestBriefId: typeof candidate.latestBriefId === "string" ? candidate.latestBriefId : null,
    latestEngineeringTaskId:
      typeof candidate.latestEngineeringTaskId === "string" ? candidate.latestEngineeringTaskId : null,
    updatedBy,
  };
}

function parseStoredJson<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  return raw as T;
}

async function readKey<T>(key: string): Promise<T | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get<string>(key);
    return parseStoredJson<T>(raw);
  } catch {
    return null;
  }
}

async function writeKey(key: string, value: unknown): Promise<boolean> {
  if (!redis) return false;
  try {
    await setWithTtl(redis, key, JSON.stringify(value), STORE_TTL_SECONDS);
    return true;
  } catch {
    return false;
  }
}

async function readHistory<T>(key: string, limit = HISTORY_LIMIT): Promise<T[]> {
  const stored = await readKey<unknown>(key);
  if (!Array.isArray(stored)) return [];
  return stored.slice(0, Math.max(0, limit)) as T[];
}

async function appendHistory<T>(key: string, item: T, limit = HISTORY_LIMIT): Promise<T> {
  if (!redis) return item;
  try {
    const existing = await readHistory<T>(key, limit);
    const next = [item, ...existing].slice(0, limit);
    await writeKey(key, next);
    return item;
  } catch {
    return item;
  }
}

export function createDefaultAgentState(now: string = getEtNowIso()): AgentState {
  return {
    asOf: now,
    posture: "NORMAL",
    eventRisk: "LOW",
    newsState: "CALM",
    allowedGrades: defaultAllowedGrades(),
    minScoreAdjustment: 0,
    maxEntriesOverride: null,
    freezeWindows: [],
    activeRestrictions: [],
    activeIncidentCount: 0,
    latestBriefId: null,
    latestEngineeringTaskId: null,
    updatedBy: "system",
  };
}

export async function readAgentStateSnapshot(): Promise<AgentStateSnapshot> {
  if (!redis) {
    return {
      state: createDefaultAgentState(),
      source: "unavailable",
    };
  }

  const stored = await readKey<unknown>(AGENT_STATE_KEY);
  if (stored == null) {
    return {
      state: createDefaultAgentState(),
      source: "missing",
    };
  }

  const state = normalizeState(stored);
  if (!state) {
    return {
      state: createDefaultAgentState(),
      source: "invalid",
    };
  }

  return {
    state,
    source: "stored",
  };
}

export async function readAgentState(): Promise<AgentState> {
  const snapshot = await readAgentStateSnapshot();
  return snapshot.state;
}

export async function ensureAgentState(): Promise<AgentState> {
  const snapshot = await readAgentStateSnapshot();
  if (snapshot.source === "stored" || snapshot.source === "unavailable") {
    return snapshot.state;
  }

  await writeAgentState(snapshot.state);
  return snapshot.state;
}

export async function writeAgentState(state: AgentState): Promise<AgentState> {
  const fallback = createDefaultAgentState(state.asOf);
  const next = normalizeState({
    ...fallback,
    ...state,
  }) ?? fallback;

  await writeKey(AGENT_STATE_KEY, next);
  return next;
}

export async function listAgentBriefs(limit = 25): Promise<AgentBrief[]> {
  return readHistory<AgentBrief>(AGENT_BRIEFS_KEY, limit);
}

export async function appendAgentBrief(brief: AgentBrief): Promise<AgentBrief> {
  return appendHistory(AGENT_BRIEFS_KEY, brief, HISTORY_LIMIT);
}

export async function listAgentIncidents(limit = 25): Promise<AgentIncident[]> {
  return readHistory<AgentIncident>(AGENT_INCIDENTS_KEY, limit);
}

export async function appendAgentIncident(incident: AgentIncident): Promise<AgentIncident> {
  return appendHistory(AGENT_INCIDENTS_KEY, incident, HISTORY_LIMIT);
}

export async function listAgentActions(limit = 25): Promise<AgentAction[]> {
  return readHistory<AgentAction>(AGENT_ACTIONS_KEY, limit);
}

export async function appendAgentAction(action: AgentAction): Promise<AgentAction> {
  return appendHistory(AGENT_ACTIONS_KEY, action, HISTORY_LIMIT);
}

export async function listEngineeringTasks(limit = 25): Promise<EngineeringTask[]> {
  return readHistory<EngineeringTask>(AGENT_ENGINEERING_KEY, limit);
}

export async function appendEngineeringTask(task: EngineeringTask): Promise<EngineeringTask> {
  return appendHistory(AGENT_ENGINEERING_KEY, task, HISTORY_LIMIT);
}