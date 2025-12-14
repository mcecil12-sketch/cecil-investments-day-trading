// app/api/signals/all/route.ts

import { NextResponse } from "next/server";
import { readJsonFile } from "@/lib/jsonDb";

export type IncomingSignal = {
  id?: string;
  ticker: string;
  side: "LONG" | "SHORT";
  entryPrice: number;
  stopPrice?: number | null;
  targetPrice?: number | null;
  reasoning?: string;
  source?: string;
  createdAt?: string;
  priority?: number;

  // Advanced quality factors (0–1 range, optional)
  trendScore?: number;
  liquidityScore?: number;
  playbookScore?: number;
  volumeScore?: number;
  catalystScore?: number;
};

async function readSignalsFile(): Promise<IncomingSignal[]> {
  return readJsonFile<IncomingSignal[]>("signals.json", []);
}

function clamp01(value: unknown, fallback: number): number {
  const num = typeof value === "number" ? value : fallback;
  if (!Number.isFinite(num)) return fallback;
  return Math.min(1, Math.max(0, num));
}

/**
 * Risk-efficiency score (0–4) based on reward:risk.
 */
function computeRiskPoints(
  entryPrice: number,
  stopPrice?: number | null,
  targetPrice?: number | null
): number {
  if (
    stopPrice == null ||
    targetPrice == null ||
    !Number.isFinite(entryPrice)
  ) {
    return 1; // neutral if we can't compute
  }

  const risk = Math.abs(entryPrice - stopPrice);
  const reward = Math.abs(targetPrice - entryPrice);

  if (!Number.isFinite(risk) || risk <= 0 || !Number.isFinite(reward)) {
    return 1;
  }

  const rr = reward / risk; // reward : risk

  if (rr >= 4) return 4;
  if (rr >= 3) return 3;
  if (rr >= 2) return 2;
  return 1;
}

/**
 * Composite A+ setup score (0–10).
 * Weights:
 *  - Risk efficiency (R:R)      → up to 4
 *  - Trend alignment           → up to 2
 *  - Liquidity / spread        → up to 1.5
 *  - Playbook fit              → up to 1.5
 *  - Volume confirmation       → up to 0.5
 *  - Catalyst presence         → up to 0.5
 */
function computeCompositePriority(s: IncomingSignal): number {
  const entry = Number(s.entryPrice);
  const stop =
    s.stopPrice != null && s.stopPrice !== undefined
      ? Number(s.stopPrice)
      : null;
  const target =
    s.targetPrice != null && s.targetPrice !== undefined
      ? Number(s.targetPrice)
      : null;

  const riskPoints = computeRiskPoints(entry, stop, target); // 1–4

  const trendScore = clamp01(s.trendScore, 0.5);
  const liquidityScore = clamp01(s.liquidityScore, 0.5);
  const playbookScore = clamp01(s.playbookScore, 0.5);
  const volumeScore = clamp01(s.volumeScore, 0.5);
  const catalystScore = clamp01(s.catalystScore, 0.0);

  const trendPoints = trendScore * 2;
  const liquidityPoints = liquidityScore * 1.5;
  const playbookPoints = playbookScore * 1.5;
  const volumePoints = volumeScore * 0.5;
  const catalystPoints = catalystScore * 0.5;

  let total =
    riskPoints +
    trendPoints +
    liquidityPoints +
    playbookPoints +
    volumePoints +
    catalystPoints;

  if (!Number.isFinite(total)) total = 0;
  total = Math.max(0, Math.min(total, 10));
  return Math.round(total * 10) / 10;
}

/**
 * Normalize a raw signal into stored format, computing priority if needed.
 */
function normalizeSignal(
  s: IncomingSignal,
  fallbackId: string,
  createdAtFallback: string
): IncomingSignal {
  const entry = Number(s.entryPrice);
  const stop =
    s.stopPrice != null && s.stopPrice !== undefined
      ? Number(s.stopPrice)
      : null;
  const target =
    s.targetPrice != null && s.targetPrice !== undefined
      ? Number(s.targetPrice)
      : null;

  const createdAt = s.createdAt ?? createdAtFallback;

  let priority: number;
  if (typeof s.priority === "number" && Number.isFinite(s.priority)) {
    priority = Math.max(0, Math.min(10, s.priority));
  } else {
    priority = computeCompositePriority({
      ...s,
      entryPrice: entry,
      stopPrice: stop,
      targetPrice: target,
      createdAt,
    });
  }

  return {
    id: s.id ?? fallbackId,
    ticker: s.ticker.toUpperCase(),
    side: s.side,
    entryPrice: entry,
    stopPrice: stop,
    targetPrice: target,
    reasoning: s.reasoning ?? "",
    source: s.source ?? "External",
    createdAt,
    priority,
    trendScore: s.trendScore,
    liquidityScore: s.liquidityScore,
    playbookScore: s.playbookScore,
    volumeScore: s.volumeScore,
    catalystScore: s.catalystScore,
  };
}

// GET: return ALL signals (any priority) for debugging
export async function GET() {
  try {
    const rawSignals = await readSignalsFile();
    const nowIso = new Date().toISOString();

    const normalized = rawSignals.map((s, idx) =>
      normalizeSignal(
        s,
        s.id ?? `signal-${Date.now()}-${idx}`,
        s.createdAt ?? nowIso
      )
    );

    const sorted = [...normalized].sort((a, b) => {
      const pa = typeof a.priority === "number" ? a.priority : 0;
      const pb = typeof b.priority === "number" ? b.priority : 0;
      if (pb !== pa) return pb - pa;

      const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
      const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
      return tb - ta;
    });

    return NextResponse.json({ signals: sorted }, { status: 200 });
  } catch (err: any) {
    console.error("GET /api/signals/all error", err);
    return NextResponse.json(
      { error: "Failed to load signals" },
      { status: 500 }
    );
  }
}
