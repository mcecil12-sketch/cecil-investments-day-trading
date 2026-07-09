/**
 * Experiment Tracker — Profit Optimization Engine
 *
 * Tracks before/after trade metrics per optimization experiment.
 * Supports automatic revert detection when an optimization degrades performance.
 *
 * Persists in Redis. TTL = TELEMETRY_DAYS.
 */

import { redis } from "@/lib/redis";
import { getTtlSeconds } from "@/lib/redis/ttl";
import { AGENT_EXPERIMENT_TRACKER_KEY } from "@/lib/agents/keys";
import { nowIso } from "@/lib/agents/time";

const STORE_TTL = getTtlSeconds("TELEMETRY_DAYS");
const MAX_EXPERIMENTS = 50;

// ─── Types ──────────────────────────────────────────────────────────

export interface ExperimentMetrics {
  winRate: number;
  avgR: number;
  tradeCount: number;
  measuredAt: string;
}

export type ExperimentStatus =
  | "ACTIVE"       // change applied, gathering afterMetrics
  | "IMPROVED"     // afterMetrics better → reinforced
  | "DEGRADED"     // afterMetrics worse → revert recommended
  | "NEUTRAL"      // no statistically significant change
  | "INSUFFICIENT" // not enough trades yet for afterMetrics
  | "REVERTED";    // manually or automatically reverted

export interface Experiment {
  id: string;
  taskId: string;
  optimizationType: string;
  description: string;
  targetFiles: string[];
  createdAt: string;
  closedAt: string | null;
  status: ExperimentStatus;
  beforeMetrics: ExperimentMetrics;
  afterMetrics: ExperimentMetrics | null;
  deltaWinRate: number | null;  // afterWinRate - beforeWinRate
  deltaR: number | null;        // afterAvgR - beforeAvgR
  minTradesForEval: number;
  revertRecommended: boolean;
}

export interface ExperimentStore {
  experiments: Experiment[];
  lastUpdatedAt: string;
}

// ─── Storage ────────────────────────────────────────────────────────

async function readExperimentStore(): Promise<ExperimentStore> {
  const empty: ExperimentStore = { experiments: [], lastUpdatedAt: nowIso() };
  if (!redis) return empty;
  try {
    const raw = await redis.get<string>(AGENT_EXPERIMENT_TRACKER_KEY);
    if (!raw) return empty;
    const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed && typeof parsed === "object" && "experiments" in parsed) {
      return parsed as ExperimentStore;
    }
    return empty;
  } catch {
    return empty;
  }
}

async function writeExperimentStore(store: ExperimentStore): Promise<void> {
  if (!redis) return;
  store.lastUpdatedAt = nowIso();
  // Keep only the most recent MAX_EXPERIMENTS
  store.experiments = store.experiments.slice(-MAX_EXPERIMENTS);
  try {
    await redis.set(AGENT_EXPERIMENT_TRACKER_KEY, JSON.stringify(store), { ex: STORE_TTL });
  } catch {
    // non-fatal
  }
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Open a new experiment when an optimization is applied.
 * Records beforeMetrics snapshot at the time of opening.
 */
export async function openExperiment(params: {
  taskId: string;
  optimizationType: string;
  description: string;
  targetFiles: string[];
  beforeMetrics: ExperimentMetrics;
  minTradesForEval?: number;
}): Promise<Experiment> {
  const store = await readExperimentStore();

  // Dedup: don't open same optimizationType twice while one is ACTIVE
  const existing = store.experiments.find(
    (e) => e.optimizationType === params.optimizationType && e.status === "ACTIVE",
  );
  if (existing) return existing;

  const exp: Experiment = {
    id: `exp-${params.optimizationType}-${Date.now().toString(36)}`,
    taskId: params.taskId,
    optimizationType: params.optimizationType,
    description: params.description,
    targetFiles: params.targetFiles,
    createdAt: nowIso(),
    closedAt: null,
    status: "ACTIVE",
    beforeMetrics: params.beforeMetrics,
    afterMetrics: null,
    deltaWinRate: null,
    deltaR: null,
    minTradesForEval: params.minTradesForEval ?? 5,
    revertRecommended: false,
  };

  store.experiments.push(exp);
  await writeExperimentStore(store);
  return exp;
}

/**
 * Close an experiment with afterMetrics.
 * Computes deltas and marks as IMPROVED / DEGRADED / NEUTRAL / INSUFFICIENT.
 * Returns true if revert is recommended.
 */
export async function closeExperiment(params: {
  experimentId: string;
  afterMetrics: ExperimentMetrics;
}): Promise<{ revertRecommended: boolean; experiment: Experiment | null }> {
  const store = await readExperimentStore();
  const exp = store.experiments.find((e) => e.id === params.experimentId);
  if (!exp) return { revertRecommended: false, experiment: null };

  exp.afterMetrics = params.afterMetrics;
  exp.closedAt = nowIso();

  if (params.afterMetrics.tradeCount < exp.minTradesForEval) {
    exp.status = "INSUFFICIENT";
    exp.deltaWinRate = null;
    exp.deltaR = null;
    exp.revertRecommended = false;
  } else {
    const deltaWinRate = params.afterMetrics.winRate - exp.beforeMetrics.winRate;
    const deltaR = params.afterMetrics.avgR - exp.beforeMetrics.avgR;
    exp.deltaWinRate = Math.round(deltaWinRate * 1000) / 1000;
    exp.deltaR = Math.round(deltaR * 1000) / 1000;

    // Degradation: win rate dropped > 5ppt OR avgR dropped > 0.2R
    const degraded = deltaWinRate < -0.05 || deltaR < -0.2;
    // Improvement: win rate up > 3ppt OR avgR up > 0.1R
    const improved = deltaWinRate > 0.03 || deltaR > 0.1;

    if (degraded) {
      exp.status = "DEGRADED";
      exp.revertRecommended = true;
    } else if (improved) {
      exp.status = "IMPROVED";
      exp.revertRecommended = false;
    } else {
      exp.status = "NEUTRAL";
      exp.revertRecommended = false;
    }
  }

  await writeExperimentStore(store);
  return { revertRecommended: exp.revertRecommended, experiment: exp };
}

/**
 * Mark an experiment as reverted (manual or auto).
 */
export async function markExperimentReverted(experimentId: string): Promise<void> {
  const store = await readExperimentStore();
  const exp = store.experiments.find((e) => e.id === experimentId);
  if (exp) {
    exp.status = "REVERTED";
    exp.closedAt = exp.closedAt ?? nowIso();
    await writeExperimentStore(store);
  }
}

/**
 * Get active experiments that need evaluation.
 */
export async function getActiveExperiments(): Promise<Experiment[]> {
  const store = await readExperimentStore();
  return store.experiments.filter((e) => e.status === "ACTIVE");
}

/**
 * Read full experiment store for diagnostics.
 */
export async function readExperiments(): Promise<ExperimentStore> {
  return readExperimentStore();
}

/**
 * Get the most recent closed experiment of a given optimizationType.
 */
export async function getLastExperiment(optimizationType: string): Promise<Experiment | null> {
  const store = await readExperimentStore();
  const matching = store.experiments
    .filter((e) => e.optimizationType === optimizationType)
    .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
  return matching[0] ?? null;
}
