// lib/signals.ts
import { readJsonFile, writeJsonFile } from "./jsonDb";

const SIGNALS_FILE = "signals.json";

export type StoredSignalSide = "LONG" | "SHORT";

export type StoredSignalStatus = "PENDING" | "APPROVED" | "DISMISSED";

export interface StoredSignal {
  id: string;
  ticker: string;
  side: StoredSignalSide;
  entryPrice: number;
  stopPrice?: number | null;
  targetPrice?: number | null;
  reasoning?: string;
  source: string;      // e.g. "Scanner", "Manual", "Sandbox"
  createdAt: string;   // ISO string
  priority: number;    // higher = more important
  status: StoredSignalStatus;
}

export async function getAllSignals(): Promise<StoredSignal[]> {
  return readJsonFile<StoredSignal[]>(SIGNALS_FILE, []);
}

export async function saveAllSignals(signals: StoredSignal[]): Promise<void> {
  await writeJsonFile<StoredSignal[]>(SIGNALS_FILE, signals);
}

export function createSignalId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

/**
 * Very simple priority model:
 * - If we have a stop, smaller risk per share → higher priority
 * - Clamped between 1 and 10 and rounded to 0.1
 */
export function computePriorityForSignal(
  entryPrice: number,
  stopPrice?: number | null
): number {
  if (stopPrice == null || !Number.isFinite(entryPrice)) {
    return 1;
  }

  const risk = Math.abs(entryPrice - stopPrice);
  if (!Number.isFinite(risk) || risk <= 0) {
    return 1;
  }

  // Smaller risk → higher priority
  let raw = 10 / risk;

  // Clamp between 1 and 10
  raw = Math.max(1, Math.min(raw, 10));

  // Round to 0.1
  return Math.round(raw * 10) / 10;
}

/**
 * Normalize a raw/incoming signal (from scanner, manual form, etc.)
 * into our StoredSignal shape with id, priority, and defaults filled in.
 */
export function normalizeIncomingSignal(
  incoming: {
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
  },
  fallbackId?: string,
  createdAtFallback?: string
): StoredSignal {
  const entry = Number(incoming.entryPrice);
  const stop =
    incoming.stopPrice != null ? Number(incoming.stopPrice) : null;
  const target =
    incoming.targetPrice != null ? Number(incoming.targetPrice) : null;

  const createdAt =
    incoming.createdAt ?? createdAtFallback ?? new Date().toISOString();

  const priority =
    typeof incoming.priority === "number"
      ? incoming.priority
      : computePriorityForSignal(entry, stop);

  return {
    id: incoming.id ?? fallbackId ?? createSignalId(),
    ticker: incoming.ticker.toUpperCase(),
    side: incoming.side,
    entryPrice: entry,
    stopPrice: stop,
    targetPrice: target,
    reasoning: incoming.reasoning ?? "",
    source: incoming.source ?? "External",
    createdAt,
    priority,
    status: "PENDING",
  };
}
