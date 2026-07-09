import { getEtDateString as getEtDateStringCore } from "@/lib/time/etDate";

export function nowIso(): string {
  return new Date().toISOString();
}

export function getEtDateString(date: Date = new Date()): string {
  return getEtDateStringCore(date);
}

function normalizeLegacyOffset(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  if (/Z$/i.test(trimmed)) return trimmed;

  // Legacy shape observed in prod: 2026-04-03T23:23:11-4
  const shortOffset = trimmed.match(/([+-])(\d{1,2})$/);
  if (shortOffset) {
    const sign = shortOffset[1];
    const hour = shortOffset[2].padStart(2, "0");
    return `${trimmed.slice(0, -shortOffset[0].length)}${sign}${hour}:00`;
  }

  // Also support offsets like +0400 or -0530
  const hhmmOffset = trimmed.match(/([+-])(\d{2})(\d{2})$/);
  if (hhmmOffset) {
    const sign = hhmmOffset[1];
    const hh = hhmmOffset[2];
    const mm = hhmmOffset[3];
    return `${trimmed.slice(0, -hhmmOffset[0].length)}${sign}${hh}:${mm}`;
  }

  return trimmed;
}

export function parseAgentTimestamp(input: unknown): Date | null {
  if (typeof input !== "string") return null;
  const normalized = normalizeLegacyOffset(input);
  const epoch = Date.parse(normalized);
  if (!Number.isFinite(epoch)) return null;
  return new Date(epoch);
}

export function toStrictIso(input: unknown, fallback: string = nowIso()): string {
  const parsed = parseAgentTimestamp(input);
  return parsed ? parsed.toISOString() : fallback;
}

export function getEtDateStringFromTimestamp(input: unknown): string | null {
  const parsed = parseAgentTimestamp(input);
  if (!parsed) return null;
  return getEtDateString(parsed);
}