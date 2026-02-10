import fs from "fs";
import path from "path";
import { redis } from "@/lib/redis";
import { TradePlan } from "@/lib/tradePlan";
import { setWithTtl, getTtlSeconds } from "@/lib/redis/ttl";

export type SignalSide = "LONG" | "SHORT";

export type StoredSignalStatus =
  | "PENDING"
  | "SCORING" // For drain claim/lock
  | "APPROVED"
  | "DISMISSED"
  | "SCORED"
  | "SKIPPED"
  | "ERROR"
  | "ARCHIVED";

export type StoredSignal = {
  id: string;
  ticker: string;
  side: SignalSide;
  direction?: SignalSide | null; // Heuristic direction based on VWAP/trend (LONG pullback vs SHORT pullback)
  entryPrice: number;
  stopPrice?: number | null;
  targetPrice?: number | null;
  timeframe?: string;
  source?: string;
  reasoning?: string;
  createdAt: string;
  updatedAt?: string;
  archived?: boolean;
  archivedAt?: string;
  scoringLockUntil?: string;
  scoringStartedAt?: string;

  // AI fields
  aiScore?: number | null;
  aiGrade?: string | null;
  aiSummary?: string | null;
  totalScore?: number | null;
  aiRawHead?: string | null;
  aiErrorReason?: string | null;
  priority?: number;
  grade?: string | null;
  score?: number | null;
  status: StoredSignalStatus;
  qualified?: boolean;
  shownInApp?: boolean;
  error?: string | null;
  tradePlan?: TradePlan | null;
  
  // Bidirectional scoring fields
  aiDirection?: SignalSide; // AI's chosen direction
  longScore?: number | null; // Score for LONG hypothesis
  shortScore?: number | null; // Score for SHORT hypothesis
  bestDirection?: "LONG" | "SHORT" | "NONE"; // AI's evaluation of best direction
};

const LOCAL_DATA_DIR = path.join(process.cwd(), "data");
const LOCAL_SIGNALS_FILE = path.join(LOCAL_DATA_DIR, "signals.json");

function ensureLocalDir() {
  if (!fs.existsSync(LOCAL_DATA_DIR)) {
    fs.mkdirSync(LOCAL_DATA_DIR, { recursive: true });
  }
}

const SIGNALS_KEY = "signals:v1";

export async function readSignals(): Promise<StoredSignal[]> {
  if (redis) {
    return (await redis.get<StoredSignal[]>(SIGNALS_KEY)) ?? [];
  }

  ensureLocalDir();
  if (!fs.existsSync(LOCAL_SIGNALS_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(LOCAL_SIGNALS_FILE, "utf8")) as StoredSignal[];
    return parsed.map((s) => ({ ...s, status: s.status ?? "PENDING" }));
  } catch {
    return [];
  }
}

export async function writeSignals(signals: StoredSignal[]): Promise<void> {
  if (redis) {
    const ttl = getTtlSeconds("SIGNALS_DAYS");
    await setWithTtl(redis, SIGNALS_KEY, signals, ttl);
    return;
  }

  ensureLocalDir();
  fs.writeFileSync(LOCAL_SIGNALS_FILE, JSON.stringify(signals, null, 2), "utf8");
}

export async function writeSignalsWithPipeline(signals: StoredSignal[]): Promise<void> {
  if (redis) {
    const ttl = getTtlSeconds("SIGNALS_DAYS");
    const pipeline = redis.pipeline();
    pipeline.set(SIGNALS_KEY, signals);
    if (ttl > 0) {
      pipeline.expire(SIGNALS_KEY, ttl);
    }
    await pipeline.exec();
    return;
  }

  ensureLocalDir();
  fs.writeFileSync(LOCAL_SIGNALS_FILE, JSON.stringify(signals, null, 2), "utf8");
}
