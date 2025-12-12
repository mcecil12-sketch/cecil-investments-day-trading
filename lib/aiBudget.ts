import fs from "fs";
import path from "path";

const BUDGET_PATH = path.join(process.cwd(), "data", "ai-budget.json");

// ---- ENV CONFIG (USD) ---------------------------------
const TOTAL_DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT ?? 10);
const MINI_DAILY_LIMIT = Number(process.env.AI_MINI_DAILY_LIMIT ?? 6);
const PRO_DAILY_LIMIT = Number(process.env.AI_PRO_DAILY_LIMIT ?? 4);

// rough per-call estimates
const COSTS: Record<string, number> = {
  "gpt-5-mini": 0.005,
  "gpt-5.1": 0.026,
};

// -------------------------------------------------------

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

type BudgetState = {
  date: string;
  totalSpent: number;
  perModel: Record<string, number>;
  alerts: {
    warn70: boolean;
    warn90: boolean;
  };
};

function emptyState(): BudgetState {
  return {
    date: todayKey(),
    totalSpent: 0,
    perModel: {},
    alerts: { warn70: false, warn90: false },
  };
}

function load(): BudgetState {
  if (!fs.existsSync(BUDGET_PATH)) return emptyState();

  const data = JSON.parse(fs.readFileSync(BUDGET_PATH, "utf-8"));
  if (data.date !== todayKey()) return emptyState();

  return data;
}

function save(state: BudgetState) {
  fs.writeFileSync(BUDGET_PATH, JSON.stringify(state, null, 2));
}

function modelLimit(model: string) {
  if (model === "gpt-5.1") return PRO_DAILY_LIMIT;
  return MINI_DAILY_LIMIT;
}

// ---- PUBLIC API ---------------------------------------

export function canSpend(model: string) {
  const state = load();
  const cost = COSTS[model] ?? 0.01;

  const modelSpent = state.perModel[model] ?? 0;

  if (state.totalSpent + cost > TOTAL_DAILY_LIMIT) return false;
  if (modelSpent + cost > modelLimit(model)) return false;

  return true;
}

export function recordSpend(model: string) {
  const state = load();
  const cost = COSTS[model] ?? 0.01;

  state.totalSpent += cost;
  state.perModel[model] = (state.perModel[model] ?? 0) + cost;

  const pct = state.totalSpent / TOTAL_DAILY_LIMIT;

  if (pct >= 0.7 && !state.alerts.warn70) {
    console.warn("⚠️ GPT spend exceeded 70% of daily budget");
    state.alerts.warn70 = true;
  }

  if (pct >= 0.9 && !state.alerts.warn90) {
    console.warn("🚨 GPT spend exceeded 90% of daily budget");
    state.alerts.warn90 = true;
  }

  save(state);
}
