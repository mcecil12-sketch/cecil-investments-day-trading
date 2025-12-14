import { redis } from "@/lib/redis";

export type AiMetrics = {
  date: string; // YYYY-MM-DD (ET)
  calls: number;
  byModel: Record<string, number>;
  lastHeartbeat: string | null;
};

function isoNow() {
  return new Date().toISOString();
}

function etDateKey(d = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);

  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${day}`;
}

function metricsKey(date: string) {
  return `ai:metrics:v1:${date}`;
}

const HEARTBEAT_KEY = "ai:heartbeat:v1";

export async function getAiMetrics(date = etDateKey()): Promise<AiMetrics> {
  const base: AiMetrics = { date, calls: 0, byModel: {}, lastHeartbeat: null };

  if (!redis) return base;

  const m = (await redis.get<AiMetrics>(metricsKey(date))) ?? base;
  const hb = (await redis.get<string>(HEARTBEAT_KEY)) ?? null;

  return {
    ...m,
    date,
    lastHeartbeat: hb,
  };
}

export async function recordHeartbeat(): Promise<void> {
  if (!redis) return;
  await redis.set(HEARTBEAT_KEY, isoNow());
}

export async function recordAiCall(model: string): Promise<void> {
  if (!redis) return;

  const date = etDateKey();
  const key = metricsKey(date);

  const current =
    (await redis.get<AiMetrics>(key)) ?? {
      date,
      calls: 0,
      byModel: {},
      lastHeartbeat: null,
    };

  current.calls = (current.calls ?? 0) + 1;
  current.byModel = current.byModel ?? {};
  current.byModel[model] = (current.byModel[model] ?? 0) + 1;

  await redis.set(key, current);
}
