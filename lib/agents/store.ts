import { redis } from "@/lib/redis";
import { getTtlSeconds, setWithTtl } from "@/lib/redis/ttl";
import { getTradingConfig } from "@/lib/tradingConfig";
import { getEtDateString, nowIso, parseAgentTimestamp, toStrictIso } from "@/lib/agents/time";
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
  AgentIncidentCategory,
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
    telemetry:
      candidate.telemetry && typeof candidate.telemetry === "object"
        ? {
            readinessReady:
              typeof candidate.telemetry.readinessReady === "boolean"
                ? candidate.telemetry.readinessReady
                : undefined,
            readinessReasons: Array.isArray(candidate.telemetry.readinessReasons)
              ? uniqueStrings(
                  candidate.telemetry.readinessReasons.filter(
                    (value): value is string => typeof value === "string"
                  )
                )
              : undefined,
            recentSignalsPending:
              typeof candidate.telemetry.recentSignalsPending === "number" &&
              Number.isFinite(candidate.telemetry.recentSignalsPending)
                ? Math.max(0, Math.floor(candidate.telemetry.recentSignalsPending))
                : undefined,
            recentSignalsScored:
              typeof candidate.telemetry.recentSignalsScored === "number" &&
              Number.isFinite(candidate.telemetry.recentSignalsScored)
                ? Math.max(0, Math.floor(candidate.telemetry.recentSignalsScored))
                : undefined,
            recentZeroScores:
              typeof candidate.telemetry.recentZeroScores === "number" &&
              Number.isFinite(candidate.telemetry.recentZeroScores)
                ? Math.max(0, Math.floor(candidate.telemetry.recentZeroScores))
                : undefined,
            scannerStale:
              typeof candidate.telemetry.scannerStale === "boolean"
                ? candidate.telemetry.scannerStale
                : undefined,
            scoringStale:
              typeof candidate.telemetry.scoringStale === "boolean"
                ? candidate.telemetry.scoringStale
                : undefined,
            autoEntryDisabled:
              typeof candidate.telemetry.autoEntryDisabled === "boolean"
                ? candidate.telemetry.autoEntryDisabled
                : undefined,
            openTradeMismatch:
              typeof candidate.telemetry.openTradeMismatch === "boolean"
                ? candidate.telemetry.openTradeMismatch
                : undefined,
          }
        : undefined,
    latestBriefId: typeof candidate.latestBriefId === "string" ? candidate.latestBriefId : null,
    latestEngineeringTaskId:
      typeof candidate.latestEngineeringTaskId === "string" ? candidate.latestEngineeringTaskId : null,
    latestEngineeringTaskTitle:
      typeof candidate.latestEngineeringTaskTitle === "string"
        ? candidate.latestEngineeringTaskTitle
        : null,
    remediationSummary:
      typeof candidate.remediationSummary === "string" ? candidate.remediationSummary : undefined,
    lastRemediationAt:
      typeof candidate.lastRemediationAt === "string" ? candidate.lastRemediationAt : null,
    openIncidentCategories: Array.isArray(candidate.openIncidentCategories)
      ? (candidate.openIncidentCategories.filter(
          (c): c is AgentIncidentCategory => typeof c === "string",
        ) as AgentIncidentCategory[])
      : undefined,
    openEngineeringTaskCount:
      typeof candidate.openEngineeringTaskCount === "number" &&
      Number.isFinite(candidate.openEngineeringTaskCount)
        ? Math.max(0, Math.floor(candidate.openEngineeringTaskCount))
        : undefined,
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

function timestampEtDate(input: unknown, fallbackIso: string): string {
  const parsed = parseAgentTimestamp(input);
  return parsed ? getEtDateString(parsed) : getEtDateString(new Date(fallbackIso));
}

function normalizeBrief(brief: AgentBrief): AgentBrief {
  const createdAt = toStrictIso(brief.createdAt);
  return {
    ...brief,
    createdAt,
    etDate: brief.etDate ?? timestampEtDate(brief.createdAt, createdAt),
  };
}

function normalizeIncidentRecord(incident: AgentIncident): AgentIncident {
  const createdAt = toStrictIso(incident.createdAt);
  const updatedAt = toStrictIso(incident.updatedAt, createdAt);
  return {
    ...incident,
    createdAt,
    updatedAt,
    etDate: incident.etDate ?? timestampEtDate(incident.createdAt, createdAt),
  };
}

function normalizeAction(action: AgentAction): AgentAction {
  const createdAt = toStrictIso(action.createdAt);
  return {
    ...action,
    createdAt,
    etDate: action.etDate ?? timestampEtDate(action.createdAt, createdAt),
  };
}

function normalizeEngineeringTask(task: EngineeringTask): EngineeringTask {
  const createdAt = toStrictIso(task.createdAt);
  const updatedAt = toStrictIso(task.updatedAt, createdAt);
  return {
    ...task,
    createdAt,
    updatedAt,
    etDate: task.etDate ?? timestampEtDate(task.createdAt, createdAt),
  };
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

export function createDefaultAgentState(now: string = nowIso()): AgentState {
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
  const strictAsOf = toStrictIso(state.asOf);
  const fallback = createDefaultAgentState(strictAsOf);
  const next = normalizeState({
    ...fallback,
    ...state,
    asOf: strictAsOf,
  }) ?? fallback;

  await writeKey(AGENT_STATE_KEY, next);
  return next;
}

export async function listAgentBriefs(limit = 25): Promise<AgentBrief[]> {
  return readHistory<AgentBrief>(AGENT_BRIEFS_KEY, limit);
}

export async function appendAgentBrief(brief: AgentBrief): Promise<AgentBrief> {
  return appendHistory(AGENT_BRIEFS_KEY, normalizeBrief(brief), HISTORY_LIMIT);
}

export async function listAgentIncidents(limit = 25): Promise<AgentIncident[]> {
  return readHistory<AgentIncident>(AGENT_INCIDENTS_KEY, limit);
}

export async function appendAgentIncident(incident: AgentIncident): Promise<AgentIncident> {
  return appendHistory(AGENT_INCIDENTS_KEY, normalizeIncidentRecord(incident), HISTORY_LIMIT);
}

type IncidentMatch = {
  category: AgentIncidentCategory;
  title: string;
};

export async function listOpenIncidents(limit = 50): Promise<AgentIncident[]> {
  const incidents = await listAgentIncidents(Math.max(limit, 100));
  return incidents.filter((incident) => incident.status !== "RESOLVED").slice(0, limit);
}

export async function findOpenIncident(match: IncidentMatch): Promise<AgentIncident | null> {
  const incidents = await listOpenIncidents(100);
  return (
    incidents.find(
      (incident) => incident.category === match.category && incident.title.trim().toUpperCase() === match.title.trim().toUpperCase()
    ) ?? null
  );
}

async function writeIncidentHistory(incidents: AgentIncident[]): Promise<void> {
  const next = incidents.map(normalizeIncidentRecord).slice(0, HISTORY_LIMIT);
  await writeKey(AGENT_INCIDENTS_KEY, next);
}

function mergeNotes(existing: string[] | undefined, incoming: string[] | undefined): string[] | undefined {
  const merged = [...(existing ?? []), ...(incoming ?? [])].map((value) => value.trim()).filter(Boolean);
  if (merged.length === 0) return undefined;
  return Array.from(new Set(merged)).slice(-10);
}

export async function upsertIncident(
  incident: Omit<AgentIncident, "id" | "createdAt" | "updatedAt" | "status"> & {
    status?: AgentIncident["status"];
  }
): Promise<{ incident: AgentIncident; created: boolean }> {
  const now = nowIso();
  const history = await listAgentIncidents(HISTORY_LIMIT);
  const idx = history.findIndex(
    (candidate) =>
      candidate.status !== "RESOLVED" &&
      candidate.category === incident.category &&
      candidate.title.trim().toUpperCase() === incident.title.trim().toUpperCase()
  );

  if (idx >= 0) {
    const current = history[idx];
    const severityRank = { LOW: 1, MEDIUM: 2, HIGH: 3 } as const;
    const merged: AgentIncident = {
      ...current,
      updatedAt: now,
      etDate: current.etDate ?? timestampEtDate(current.createdAt, current.createdAt),
      source: incident.source,
      severity:
        severityRank[incident.severity] > severityRank[current.severity]
          ? incident.severity
          : current.severity,
      summary: incident.summary,
      notes: mergeNotes(current.notes, incident.notes),
      // Preserve MONITORING status unless an explicit override is provided
      status: incident.status ?? (current.status === "MONITORING" ? "MONITORING" : "OPEN"),
    };
    const withoutCurrent = history.filter((_, rowIndex) => rowIndex !== idx);
    const next = [merged, ...withoutCurrent];
    await writeIncidentHistory(next);
    return { incident: merged, created: false };
  }

  const created: AgentIncident = {
    ...incident,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    etDate: getEtDateString(new Date(now)),
    status: incident.status ?? "OPEN",
  };

  await writeIncidentHistory([created, ...history]);
  return { incident: created, created: true };
}

export async function resolveIncident(match: IncidentMatch, note?: string): Promise<AgentIncident | null> {
  const now = nowIso();
  const history = await listAgentIncidents(HISTORY_LIMIT);
  const idx = history.findIndex(
    (candidate) =>
      candidate.status !== "RESOLVED" &&
      candidate.category === match.category &&
      candidate.title.trim().toUpperCase() === match.title.trim().toUpperCase()
  );
  if (idx < 0) return null;

  const current = history[idx];
  const resolved: AgentIncident = {
    ...current,
    status: "RESOLVED",
    updatedAt: now,
    notes: mergeNotes(current.notes, note ? [note] : undefined),
  };

  const next = [...history];
  next[idx] = resolved;
  await writeIncidentHistory(next);
  return resolved;
}

export async function listAgentActions(limit = 25): Promise<AgentAction[]> {
  return readHistory<AgentAction>(AGENT_ACTIONS_KEY, limit);
}

export async function appendAgentAction(action: AgentAction): Promise<AgentAction> {
  return appendHistory(AGENT_ACTIONS_KEY, normalizeAction(action), HISTORY_LIMIT);
}

export async function listEngineeringTasks(limit = 25): Promise<EngineeringTask[]> {
  return readHistory<EngineeringTask>(AGENT_ENGINEERING_KEY, limit);
}

export async function appendEngineeringTask(task: EngineeringTask): Promise<EngineeringTask> {
  return appendHistory(AGENT_ENGINEERING_KEY, normalizeEngineeringTask(task), HISTORY_LIMIT);
}

export async function findOpenEngineeringTaskByIncident(
  incidentId: string,
): Promise<EngineeringTask | null> {
  const tasks = await listEngineeringTasks(HISTORY_LIMIT);
  return (
    tasks.find(
      (task) =>
        task.incidentId === incidentId &&
        (task.status === "OPEN" ||
          task.status === "IN_PROGRESS" ||
          task.status === "READY_FOR_REVIEW"),
    ) ?? null
  );
}

export async function upsertEngineeringTask(
  task: EngineeringTask,
): Promise<{ task: EngineeringTask; created: boolean }> {
  if (task.incidentId) {
    const existing = await findOpenEngineeringTaskByIncident(task.incidentId);
    if (existing) {
      return { task: existing, created: false };
    }
  }
  const created = await appendEngineeringTask(task);
  return { task: created, created: true };
}

export async function updateIncidentById(
  id: string,
  updates: Partial<Pick<AgentIncident, "status" | "severity" | "summary">>,
  note?: string,
): Promise<AgentIncident | null> {
  const now = nowIso();
  const history = await listAgentIncidents(HISTORY_LIMIT);
  const idx = history.findIndex((inc) => inc.id === id);
  if (idx < 0) return null;

  const current = history[idx];
  const updated: AgentIncident = {
    ...current,
    ...updates,
    updatedAt: now,
    notes: mergeNotes(current.notes, note ? [note] : undefined),
  };

  const next = [...history];
  next[idx] = normalizeIncidentRecord(updated);
  await writeIncidentHistory(next);
  return updated;
}