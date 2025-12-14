import fs from "fs";
import path from "path";
import { Redis } from "@upstash/redis";

const IS_PROD = process.env.VERCEL === "1";
const DATA_DIR = IS_PROD ? "/tmp" : path.join(process.cwd(), "data");
const SIGNALS_FILE = path.join(DATA_DIR, "signals.json");

const redis =
  IS_PROD &&
  process.env.UPSTASH_REDIS_REST_URL &&
  process.env.UPSTASH_REDIS_REST_TOKEN
    ? new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      })
    : null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function readJsonFile<T>(filename: string, fallback: T): T {
  ensureDataDir();
  const p = path.join(DATA_DIR, filename);
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonFile<T>(filename: string, value: T) {
  ensureDataDir();
  const p = path.join(DATA_DIR, filename);
  fs.writeFileSync(p, JSON.stringify(value, null, 2), "utf8");
}

export async function readSignals<T = unknown[]>(): Promise<T> {
  if (redis) {
    return (await redis.get<T>("signals")) ?? ([] as unknown as T);
  }
  ensureDataDir();
  try {
    if (!fs.existsSync(SIGNALS_FILE)) return [] as unknown as T;
    return JSON.parse(fs.readFileSync(SIGNALS_FILE, "utf8")) as T;
  } catch {
    return [] as unknown as T;
  }
}

export async function writeSignals<T = unknown[]>(value: T): Promise<void> {
  if (redis) {
    await redis.set("signals", value);
    return;
  }
  ensureDataDir();
  fs.writeFileSync(SIGNALS_FILE, JSON.stringify(value, null, 2), "utf8");
}
