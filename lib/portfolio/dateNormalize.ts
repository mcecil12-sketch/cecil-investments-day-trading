/**
 * Claude sometimes returns an as-of date as something like "Jul-10-2026 at 5:58
 * p.m. ET" despite being asked for YYYY-MM-DD — strip the time/timezone suffix
 * and the dashes so `new Date()` has a shot at parsing it, and fall back to
 * today rather than failing the whole import over a date string.
 */
export function normalizeAsOfDate(raw: string): string {
  const cleaned = raw.split(/\s+at\s+/i)[0].replace(/-/g, " ").trim();
  const parsed = new Date(cleaned);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }
  return parsed.toISOString().slice(0, 10);
}
