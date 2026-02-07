export type SinceField = "createdAt" | "updatedAt" | "scoredAt";

function parseDurationToMs(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d+)(m|h|d)$/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2].toLowerCase();
  if (unit === "m") return value * 60_000;
  if (unit === "h") return value * 60 * 60_000;
  if (unit === "d") return value * 24 * 60 * 60_000;
  return null;
}

export function parseSince(raw: string | null, nowMs = Date.now()): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const ms = parseDurationToMs(trimmed);
  if (ms != null) return new Date(nowMs - ms);
  const t = Date.parse(trimmed);
  if (Number.isFinite(t)) return new Date(t);
  return null;
}

export function resolveSinceField(raw: string | null): SinceField {
  const value = (raw || "").trim().toLowerCase();
  if (value === "updatedat") return "updatedAt";
  if (value === "scoredat") return "scoredAt";
  return "createdAt";
}

export function getSignalTimestampMs(signal: any, field: SinceField): number | null {
  const raw = signal?.[field];
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}
