import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";

const ACTIVITY_FILE = path.join(process.cwd(), "data", "activity.json");
const MAX_ENTRIES = 500;

export type ActivityEntry = {
  id: string;
  timestamp: string;
  type: string;
  tradeId?: string;
  ticker?: string;
  message?: string;
  meta?: Record<string, any>;
};

async function readActivity(): Promise<ActivityEntry[]> {
  try {
    const raw = await fs.readFile(ACTIVITY_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ActivityEntry[]) : [];
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

async function writeActivity(entries: ActivityEntry[]) {
  await fs.mkdir(path.dirname(ACTIVITY_FILE), { recursive: true });
  await fs.writeFile(
    ACTIVITY_FILE,
    JSON.stringify(entries.slice(-MAX_ENTRIES), null, 2),
    "utf8"
  );
}

export async function appendActivity(entry: Omit<ActivityEntry, "id" | "timestamp">) {
  const entries = await readActivity();
  const newEntry: ActivityEntry = {
    ...entry,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
  };
  entries.push(newEntry);
  await writeActivity(entries);
}

export async function getRecentActivity(limit = 200): Promise<ActivityEntry[]> {
  const entries = await readActivity();
  return entries.slice(-limit).reverse();
}
