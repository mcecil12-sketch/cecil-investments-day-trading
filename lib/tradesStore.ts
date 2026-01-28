import { promises as fs } from "fs";
import path from "path";
import { redis } from "@/lib/redis";
import { setWithTtl, getTtlSeconds } from "@/lib/redis/ttl";

const DATA_PATH = path.join(process.cwd(), "data");
const TRADES_FILE = path.join(DATA_PATH, "trades.json");
const REDIS_KEY = `trades:v1:${process.env.VERCEL_ENV ?? "local"}`;

async function ensureFile(): Promise<void> {
  try {
    await fs.access(TRADES_FILE);
  } catch {
    await fs.mkdir(DATA_PATH, { recursive: true });
    await fs.writeFile(TRADES_FILE, "[]", "utf8");
  }
}

async function readFromFile<T = any>(): Promise<T[]> {
  await ensureFile();
  const raw = await fs.readFile(TRADES_FILE, "utf8");
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : parsed.trades ?? [];
  } catch {
    return [];
  }
}

async function writeToFile<T = any>(trades: T[]): Promise<void> {
  await fs.mkdir(DATA_PATH, { recursive: true });
  await fs.writeFile(TRADES_FILE, JSON.stringify(trades, null, 2), "utf8");
}

async function readFromRedis<T = any>(): Promise<T[]> {
  if (!redis) return [];
  const value = await redis.get(REDIS_KEY);
  if (!value) return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

async function writeToRedis<T = any>(trades: T[]): Promise<void> {
  if (!redis) return;
  const ttl = getTtlSeconds("TRADES_DAYS");
  await setWithTtl(redis, REDIS_KEY, JSON.stringify(trades), ttl);
}

export async function readTrades<T = any>(): Promise<T[]> {
  if (redis) {
    return readFromRedis();
  }
  return readFromFile();
}

export async function writeTrades<T = any>(trades: T[]): Promise<void> {
  if (redis) {
    await writeToRedis(trades);
    return;
  }
  return writeToFile(trades);
}

export async function upsertTrade<T extends { id: string }>(trade: T): Promise<void> {
  const trades = await readTrades<T>();
  const idx = trades.findIndex((t) => t.id === trade.id);
  if (idx === -1) {
    trades.unshift(trade);
  } else {
    trades[idx] = trade;
  }
  await writeTrades(trades);
}
