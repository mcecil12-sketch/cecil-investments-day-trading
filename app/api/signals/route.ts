import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { sendPullbackAlert } from "@/lib/notify";

type TradeSide = "LONG" | "SHORT";

export interface Signal {
  id: string;
  ticker: string;
  side: TradeSide;
  entryPrice: number;
  stopPrice?: number;
  targetPrice?: number;
  reasoning?: string;
  source?: string;
  createdAt: string;
  priority?: number; // 0–10 A+ score

  // Optional advanced scoring
  trendScore?: number;
  liquidityScore?: number;
  playbookScore?: number;
  volumeScore?: number;
  catalystScore?: number;
}

interface SignalsFileShape {
  signals: Signal[];
}

const SIGNALS_FILE = path.join(process.cwd(), "data", "signals.json");

async function readSignalsFile(): Promise<Signal[]> {
  try {
    const raw = await fs.readFile(SIGNALS_FILE, "utf8");
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) return parsed as Signal[];
    if (parsed && Array.isArray(parsed.signals)) return parsed.signals as Signal[];
    return [];
  } catch (err: any) {
    if (err.code === "ENOENT") return [];
    console.error("[signals] Error reading signals file:", err);
    throw err;
  }
}

async function writeSignalsFile(signals: Signal[]): Promise<void> {
  const wrapper: SignalsFileShape = { signals };
  const data = JSON.stringify(wrapper, null, 2);
  await fs.mkdir(path.dirname(SIGNALS_FILE), { recursive: true });
  await fs.writeFile(SIGNALS_FILE, data, "utf8");
}

// Compute priority (A+ score) from component scores if not provided
function computePriority(sig: Signal): number | undefined {
  const parts = [
    sig.trendScore,
    sig.liquidityScore,
    sig.playbookScore,
    sig.volumeScore,
    sig.catalystScore,
  ].filter((v) => typeof v === "number") as number[];

  if (!parts.length) return sig.priority;

  // Average 0–1 → scale to 0–10
  const avg = parts.reduce((a, b) => a + b, 0) / parts.length;
  return Math.round(avg * 10 * 10) / 10; // one decimal place
}

// GET /api/signals -> { signals }
export async function GET() {
  try {
    const signals = await readSignalsFile();
    return NextResponse.json(
      { signals },
      { status: 200 }
    );
  } catch (err) {
    console.error("[signals] GET error:", err);
    return NextResponse.json(
      { error: "Failed to load signals" },
      { status: 500 }
    );
  }
}

// POST /api/signals
//
// Supports either:
//  - single object: { ticker, side, entryPrice, ... }
//  - array: [ { ... }, { ... } ]  (used by /api/scan)
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const incoming = Array.isArray(body) ? body : [body];

    const now = new Date().toISOString();
    const existing = await readSignalsFile();
    const next: Signal[] = [...existing];

    for (const raw of incoming) {
      const ticker: string = raw.ticker;
      const sideRaw: string = raw.side;
      const entryPrice: number = Number(raw.entryPrice);
      const stopPrice: number | undefined =
        raw.stopPrice !== undefined ? Number(raw.stopPrice) : undefined;
      const targetPrice: number | undefined =
        raw.targetPrice !== undefined ? Number(raw.targetPrice) : undefined;

      if (!ticker || !sideRaw || !entryPrice) {
        console.warn("[signals] Skipping invalid signal payload:", raw);
        continue;
      }

      const side: TradeSide =
        sideRaw.toUpperCase() === "SHORT" ? "SHORT" : "LONG";

      const reasoning: string | undefined =
        typeof raw.reasoning === "string" ? raw.reasoning : undefined;

      const source: string | undefined =
        typeof raw.source === "string" ? raw.source : "VWAP Scanner";

      const trendScore =
        raw.trendScore !== undefined ? Number(raw.trendScore) : undefined;
      const liquidityScore =
        raw.liquidityScore !== undefined ? Number(raw.liquidityScore) : undefined;
      const playbookScore =
        raw.playbookScore !== undefined ? Number(raw.playbookScore) : undefined;
      const volumeScore =
        raw.volumeScore !== undefined ? Number(raw.volumeScore) : undefined;
      const catalystScore =
        raw.catalystScore !== undefined ? Number(raw.catalystScore) : undefined;

      const signal: Signal = {
        id: raw.id || `sig-${ticker}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        ticker: ticker.toUpperCase(),
        side,
        entryPrice,
        stopPrice,
        targetPrice,
        reasoning,
        source,
        createdAt: raw.createdAt || now,
        // temp priority before compute
        priority: raw.priority !== undefined ? Number(raw.priority) : undefined,
        trendScore,
        liquidityScore,
        playbookScore,
        volumeScore,
        catalystScore,
      };

      signal.priority = computePriority(signal);
      next.push(signal);

      // Alert hook: only for A-grade or score >= 9
      const isAGrade =
        raw.grade === "A" ||
        (typeof raw.score === "number" && raw.score >= 9);

      if (isAGrade) {
        await sendPullbackAlert({
          ticker: signal.ticker,
          side: signal.side,
          entryPrice: signal.entryPrice,
          stopPrice: signal.stopPrice,
          score: raw.score,
          reason: signal.reasoning,
        });
      }
    }

    await writeSignalsFile(next);

    return NextResponse.json(
      { ok: true, count: incoming.length },
      { status: 201 }
    );
  } catch (err) {
    console.error("[signals] POST error:", err);
    return NextResponse.json(
      { ok: false, error: "Failed to save signal(s)" },
      { status: 500 }
    );
  }
}

// DELETE /api/signals?id=...  -> remove one signal
export async function DELETE(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json(
        { ok: false, error: "id query parameter is required" },
        { status: 400 }
      );
    }

    const signals = await readSignalsFile();
    const next = signals.filter((s) => s.id !== id);
    await writeSignalsFile(next);

    return NextResponse.json(
      { ok: true, removedId: id },
      { status: 200 }
    );
  } catch (err) {
    console.error("[signals] DELETE error:", err);
    return NextResponse.json(
      { ok: false, error: "Failed to delete signal" },
      { status: 500 }
    );
  }
}
