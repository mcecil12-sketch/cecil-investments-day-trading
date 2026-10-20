/**
 * US equity session helpers (America/New_York). Tracking charts compare picks
 * and the S&P 500 on completed daily closes only, so both lines always share
 * the same as-of moment: yesterday's close during market hours, today's close
 * once it has settled after 4pm ET. Market holidays are not modeled; on a
 * holiday the newest available bar simply stays the previous session's.
 */

const NY = "America/New_York";

/** Minutes after midnight ET at which today's close is treated as settled (4:15pm, a buffer after the 4:00pm close). */
export const CLOSE_SETTLED_MINUTES = 16 * 60 + 15;

function nyParts(d: Date): { key: string; weekday: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NY,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    key: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: get("weekday"),
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/** NY calendar date (YYYY-MM-DD) of an instant. */
export function nyDateKey(d: Date): string {
  return nyParts(d).key;
}

function isWeekday(weekday: string): boolean {
  return weekday !== "Sat" && weekday !== "Sun";
}

/** True while today's NY session could still produce a partial daily bar: a weekday before 4:15pm ET. */
export function isTodaySessionUnsettled(now: Date = new Date()): boolean {
  const p = nyParts(now);
  return isWeekday(p.weekday) && p.minutes < CLOSE_SETTLED_MINUTES;
}

/** NY date key of the most recent weekday session whose close has settled. */
export function lastSettledSessionKey(now: Date = new Date()): string {
  let cursor = new Date(now.getTime());
  const p = nyParts(cursor);
  if (isWeekday(p.weekday) && p.minutes >= CLOSE_SETTLED_MINUTES) return p.key;
  for (let i = 0; i < 7; i++) {
    cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
    const q = nyParts(cursor);
    if (isWeekday(q.weekday)) return q.key;
  }
  return p.key;
}

/** Drops the final daily bar when it belongs to today's not-yet-settled session. Bars are Yahoo daily points, timestamped during their own NY session. */
export function dropUnsettledSessionBar<T extends { date: Date }>(points: T[], now: Date = new Date()): T[] {
  if (points.length === 0 || !isTodaySessionUnsettled(now)) return points;
  const last = points[points.length - 1];
  return nyDateKey(last.date) === nyDateKey(now) ? points.slice(0, -1) : points;
}
