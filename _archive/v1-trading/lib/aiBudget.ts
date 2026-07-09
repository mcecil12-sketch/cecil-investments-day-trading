import { redis } from "@/lib/redis";

export type AiBudgetState = {
  date: string; // YYYY-MM-DD
  totalSpent: number;
  perModel: Record<string, number>;
  alerts: { warn70: boolean; warn90: boolean };
};

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function keyFor(date: string) {
  return `ai:budget:${date}`;
}

const DEFAULT_STATE: AiBudgetState = {
  date: todayUTC(),
  totalSpent: 0,
  perModel: {},
  alerts: { warn70: false, warn90: false },
};

export async function getBudgetState(date = todayUTC()): Promise<AiBudgetState> {
  const key = keyFor(date);
  if (!redis) {
    return { ...DEFAULT_STATE, date };
  }
  const value = await redis.get(key);
  if (!value) {
    return { ...DEFAULT_STATE, date };
  }
  try {
    return typeof value === "string"
      ? (JSON.parse(value) as AiBudgetState)
      : (value as AiBudgetState);
  } catch {
    return { ...DEFAULT_STATE, date };
  }
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export async function addSpend(params: {
  model: string;
  amountUsd: number;
  date?: string;
}) {
  const date = params.date ?? todayUTC();
  const key = keyFor(date);

  const state = await getBudgetState(date);
  const next: AiBudgetState = {
    ...state,
    date,
    totalSpent: round2(state.totalSpent + (params.amountUsd || 0)),
    perModel: {
      ...state.perModel,
      [params.model]: round2(
        (state.perModel[params.model] || 0) + (params.amountUsd || 0)
      ),
    },
  };

  await redis?.set(key, JSON.stringify(next));
  return next;
}

export async function recordSpend(model: string, amountUsd: number) {
  try {
    await addSpend({ model, amountUsd });
  } catch (e) {
    console.log(
      "[aiBudget] recordSpend failed (non-fatal):",
      (e as any)?.message ?? String(e)
    );
  }
}
