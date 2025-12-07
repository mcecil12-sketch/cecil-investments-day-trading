import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

type Settings = {
  autoManagementEnabled?: boolean;
  maxRiskPerTrade?: number;
  maxRiskPerDay?: number;
  maxTradesPerDay?: number;
  autoEntryReady?: boolean;
  autoEntryNotes?: string;
  [key: string]: any;
};

const SETTINGS_FILE = path.join(process.cwd(), "data", "settings.json");

async function readSettings(): Promise<Settings> {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, "utf8");
    return JSON.parse(raw) as Settings;
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { autoManagementEnabled: false };
    }
    throw err;
  }
}

async function writeSettings(settings: Settings): Promise<void> {
  await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
}

export async function GET() {
  try {
    const settings = await readSettings();
    return NextResponse.json({ settings }, { status: 200 });
  } catch (err) {
    console.error("GET /api/settings error:", err);
    return NextResponse.json(
      { error: "Failed to load settings" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const current = await readSettings();
    const updated = { ...current, ...body };
    await writeSettings(updated);
    return NextResponse.json({ settings: updated }, { status: 200 });
  } catch (err) {
    console.error("POST /api/settings error:", err);
    return NextResponse.json(
      { error: "Failed to update settings" },
      { status: 500 }
    );
  }
}
