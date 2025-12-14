import fs from "fs";
import path from "path";

const IS_VERCEL = process.env.VERCEL === "1";
const DATA_DIR = IS_VERCEL ? "/tmp" : path.join(process.cwd(), "data");

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

export async function readSignals<T = unknown[]>(filename = "signals.json"): Promise<T> {
  return readJsonFile<T>(filename, [] as unknown as T);
}

export function writeSignals<T = unknown[]>(filename = "signals.json", value: T) {
  writeJsonFile<T>(filename, value);
}
