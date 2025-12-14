import fs from "fs";
import path from "path";

const METRICS_PATH = path.join(process.cwd(), "data", "ai-metrics.json");

type Metrics = {
  date: string;
  calls: number;
  byModel: Record<string, number>;
  lastHeartbeat?: string;
};

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function empty(): Metrics {
  return {
    date: todayKey(),
    calls: 0,
    byModel: {},
  };
}

function load(): Metrics {
  if (!fs.existsSync(METRICS_PATH)) return empty();

  const data = JSON.parse(fs.readFileSync(METRICS_PATH, "utf-8"));
  if (data.date !== todayKey()) return empty();

  return data;
}

function save(data: Metrics) {
  fs.writeFileSync(METRICS_PATH, JSON.stringify(data, null, 2));
}

export function recordAICall(model: string) {
  const data = load();

  data.calls += 1;
  data.byModel[model] = (data.byModel[model] ?? 0) + 1;
  data.lastHeartbeat = new Date().toISOString();

  save(data);
}

export function heartbeatMetrics() {
  const data = load();
  data.lastHeartbeat = new Date().toISOString();
  save(data);
}
