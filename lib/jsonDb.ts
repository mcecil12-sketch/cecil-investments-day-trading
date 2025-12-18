import fs from "fs";
import path from "path";
import { redis } from "@/lib/redis";

export type SignalSide = "LONG" | "SHORT";

export type StoredSignalStatus =
  | "PENDING"
  | "APPROVED"
  | "DISMISSED"
  | "SCORED"
  | "ARCHIVED";

export type StoredSignal = {
  id: string;
  ticker: string;
  side: SignalSide;
  entryPrice: number;
  stopPrice?: number | null;
  targetPrice?: number | null;
  timeframe?: string;
  source?: string;
  reasoning?: string;
  createdAt: string;

  // AI fields
  aiScore?: number;
  aiGrade?: string;
  aiSummary?: string;
  totalScore?: number;
  priority?: number;
  grade?: string | null;
  score?: number | null;
  status: StoredSignalStatus;
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
    await redis.set(SIGNALS_KEY, signals);
    return;
  }

  ensureLocalDir();
  fs.writeFileSync(LOCAL_SIGNALS_FILE, JSON.stringify(signals, null, 2), "utf8");
}
