// lib/jsonDb.ts
import { promises as fs } from "fs";
import path from "path";

function resolveDataPath(fileName: string) {
  return path.join(process.cwd(), "data", fileName);
}

export async function readJsonFile<T>(fileName: string, fallback: T): Promise<T> {
  const filePath = resolveDataPath(fileName);

  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (err: any) {
    // If file doesn't exist yet, initialize it with fallback
    if (err?.code === "ENOENT") {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(fallback, null, 2), "utf8");
      return fallback;
    }
    console.error(`Error reading ${fileName}`, err);
    throw err;
  }
}

export async function writeJsonFile<T>(fileName: string, data: T): Promise<void> {
  const filePath = resolveDataPath(fileName);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}
