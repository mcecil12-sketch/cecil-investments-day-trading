const ET_TIME_ZONE = "America/New_York";

const datePartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: ET_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const dateTimePartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: ET_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZoneName: "shortOffset",
});

function part(parts: Intl.DateTimeFormatPart[], type: string, fallback: string) {
  return parts.find((p) => p.type === type)?.value ?? fallback;
}

export function getEtNow(): Date {
  return new Date();
}

export function getEtDateString(d: Date = getEtNow()): string {
  const parts = datePartsFormatter.formatToParts(d);
  const y = part(parts, "year", "1970");
  const m = part(parts, "month", "01");
  const day = part(parts, "day", "01");
  return `${y}-${m}-${day}`;
}

export function getEtNowIso(d: Date = getEtNow()): string {
  const parts = dateTimePartsFormatter.formatToParts(d);
  const y = part(parts, "year", "1970");
  const m = part(parts, "month", "01");
  const day = part(parts, "day", "01");
  const hh = part(parts, "hour", "00");
  const mm = part(parts, "minute", "00");
  const ss = part(parts, "second", "00");
  const tzRaw = part(parts, "timeZoneName", "GMT-05:00");
  const offset = tzRaw.replace("GMT", "") || "-05:00";
  return `${y}-${m}-${day}T${hh}:${mm}:${ss}${offset}`;
}

// ─── ET-Day Boundary Utilities ──────────────────────────────────────
// These provide consistent ET-day filtering across routes

/**
 * Get the UTC millisecond boundaries for an ET date.
 * Uses Intl.DateTimeFormat to correctly handle DST transitions.
 *
 * @param dateET - Date string in YYYY-MM-DD format (defaults to today in ET)
 * @returns { startMs: number, endMs: number } - UTC millisecond boundaries
 */
export function getEtDayBoundsMs(dateET?: string): { startMs: number; endMs: number } {
  const targetDate = dateET ?? getEtDateString();
  
  // Parse the date components
  const [year, month, day] = targetDate.split("-").map(Number);
  
  // Create a date at midnight ET for this day
  // We'll use a binary search approach to find the exact transition point
  // Start with a rough estimate using the common offsets
  
  // Get the offset at midnight for this date
  // Create a date object at what we think is midnight ET
  const roughMidnight = new Date(`${targetDate}T12:00:00Z`); // Noon UTC as a starting point
  
  // Format to get the actual ET date at this UTC time
  const checkDate = getEtDateString(roughMidnight);
  
  // Adjust based on whether our guess is correct
  // ET is UTC-5 (EST) or UTC-4 (EDT)
  // So midnight ET = 04:00 or 05:00 UTC
  
  // Try EDT offset first (UTC-4)
  let startMs = Date.UTC(year, month - 1, day, 4, 0, 0, 0);
  let testDate = getEtDateString(new Date(startMs));
  
  // If our EDT guess gives wrong date, try EST (UTC-5)
  if (testDate !== targetDate) {
    startMs = Date.UTC(year, month - 1, day, 5, 0, 0, 0);
    testDate = getEtDateString(new Date(startMs));
  }
  
  // If still wrong, we might be off by a day - adjust
  if (testDate !== targetDate) {
    // Try the previous UTC day with EDT
    startMs = Date.UTC(year, month - 1, day - 1, 4, 0, 0, 0);
    testDate = getEtDateString(new Date(startMs));
    if (testDate !== targetDate) {
      // Try previous UTC day with EST
      startMs = Date.UTC(year, month - 1, day - 1, 5, 0, 0, 0);
    }
  }
  
  // End is 24 hours after start
  const endMs = startMs + 24 * 60 * 60 * 1000;
  
  return { startMs, endMs };
}

/**
 * Check if a UTC timestamp falls within an ET day.
 *
 * @param timestampMs - UTC millisecond timestamp
 * @param dateET - Optional ET date string (defaults to today)
 * @returns true if the timestamp is within the ET day
 */
export function isTimestampInEtDay(timestampMs: number, dateET?: string): boolean {
  if (!Number.isFinite(timestampMs)) return false;
  const { startMs, endMs } = getEtDayBoundsMs(dateET);
  return timestampMs >= startMs && timestampMs < endMs;
}

/**
 * Get the ET date string for a given UTC timestamp.
 * Convenience wrapper around getEtDateString.
 *
 * @param timestampMs - UTC millisecond timestamp
 * @returns ET date string in YYYY-MM-DD format
 */
export function getEtDateFromTimestamp(timestampMs: number): string {
  return getEtDateString(new Date(timestampMs));
}

/**
 * Check if two timestamps are on the same ET day.
 *
 * @param ts1Ms - First UTC millisecond timestamp  
 * @param ts2Ms - Second UTC millisecond timestamp
 * @returns true if both timestamps are on the same ET day
 */
export function isSameEtDay(ts1Ms: number, ts2Ms: number): boolean {
  return getEtDateFromTimestamp(ts1Ms) === getEtDateFromTimestamp(ts2Ms);
}
