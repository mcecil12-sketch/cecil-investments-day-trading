import { readSignals, writeSignals, StoredSignal } from "@/lib/jsonDb";

export async function getAllSignals(): Promise<StoredSignal[]> {
  return readSignals();
}

export async function upsertSignal(signal: StoredSignal): Promise<void> {
  const signals = await readSignals();
  const idx = signals.findIndex((s) => s.id === signal.id);
  if (idx >= 0) {
    signals[idx] = signal;
  } else {
    signals.push(signal);
  }
  await writeSignals(signals);
}

export type { StoredSignal };
